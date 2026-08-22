from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from cua_sandbox import Image, Sandbox
from cua_sandbox.runtime.base import Runtime, RuntimeInfo

from .models import DesktopInfo
from .settings import Settings


class DockerCommandError(RuntimeError):
    pass


def _docker_binary() -> str:
    binary = shutil.which("docker")
    if not binary:
        raise DockerCommandError("Docker CLI was not found on PATH")
    return binary


def _run_docker(
    args: list[str], *, check: bool = True, timeout: int = 60
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [_docker_binary(), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        shell=False,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise DockerCommandError(f"docker {' '.join(args[:3])} failed: {detail}")
    return result


async def _docker(
    args: list[str], *, check: bool = True, timeout: int = 60
) -> subprocess.CompletedProcess[str]:
    return await asyncio.to_thread(_run_docker, args, check=check, timeout=timeout)


def _view_url(host: str, port: int) -> str:
    return f"http://{host}:{port}/vnc.html?autoconnect=true&resize=scale"


class DockerRuntime(Runtime):
    """Loopback-only Docker lifecycle compatible with Cua RuntimeInfo."""

    def __init__(self, settings: Settings):
        self.settings = settings

    async def start(self, image: Image, name: str, **opts: Any) -> RuntimeInfo:
        docker_image = image._registry or self.settings.image
        inspect = await _docker(["image", "inspect", docker_image], check=False)
        if inspect.returncode != 0:
            raise RuntimeError(
                f"Docker image {docker_image!r} is missing. Run "
                "`cua-desktop-pool build-image` first."
            )
        if await self._container_exists(name):
            raise ValueError(f"Container {name!r} already exists")

        args = [
            "run",
            "-d",
            "--name",
            name,
            "--label",
            "cua.sandbox=true",
            "--label",
            "cua.pool=true",
            "--label",
            f"cua.pool.prefix={self.settings.prefix}",
            "--cpus",
            str(self.settings.cpus),
            "--memory",
            f"{self.settings.memory_mb}m",
            "--pids-limit",
            "2048",
            "--shm-size",
            "512m",
            "--stop-timeout",
            "30",
            "-p",
            "127.0.0.1::8000",
            "-p",
            "127.0.0.1::6901",
        ]
        if self.settings.docker_network:
            args.extend(["--network", self.settings.docker_network])
        for key, value in image._env:
            args.extend(["-e", f"{key}={value}"])
        args.append(docker_image)

        result = await _docker(args, timeout=120)
        container_id = result.stdout.strip()[:12]
        try:
            api_port = await self._mapped_port(name, 8000)
            vnc_port = await self._mapped_port(name, 6901)
            control_host, control_port = self.control_endpoint(name, api_port)
            info = RuntimeInfo(
                host=control_host,
                api_port=control_port,
                vnc_port=vnc_port,
                container_id=container_id,
                name=name,
                environment="linux",
            )
            await self.is_ready(info, timeout=self.settings.ready_timeout)
            return info
        except BaseException as error:
            logs = await _docker(["logs", "--tail", "80", name], check=False, timeout=20)
            await _docker(["rm", "-f", name], check=False, timeout=30)
            detail = (logs.stdout + logs.stderr).strip()
            if detail:
                raise RuntimeError(
                    f"Desktop failed to start. Last container logs:\n{detail}"
                ) from error
            raise

    async def stop(self, name: str) -> None:
        await self._require_pool_container(name)
        await _docker(["rm", "-f", name], timeout=60)

    async def is_ready(self, info: RuntimeInfo, timeout: float = 120) -> bool:
        deadline = asyncio.get_running_loop().time() + timeout
        url = f"http://{info.host}:{info.api_port}/status"
        async with httpx.AsyncClient(timeout=5.0) as client:
            while asyncio.get_running_loop().time() < deadline:
                try:
                    response = await client.get(url)
                    if response.status_code == 200:
                        return True
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(2)
        raise TimeoutError(f"Container {info.name!r} was not ready after {timeout}s")

    async def suspend(self, name: str) -> None:
        await self._require_pool_container(name)
        await _docker(["pause", name])

    async def resume(self, image: Image, name: str, **opts: Any) -> RuntimeInfo:
        await self._require_pool_container(name)
        await _docker(["unpause", name])
        mapped_api_port = await self._mapped_port(name, 8000)
        control_host, control_port = self.control_endpoint(name, mapped_api_port)
        info = RuntimeInfo(
            host=control_host,
            api_port=control_port,
            vnc_port=await self._mapped_port(name, 6901),
            name=name,
            environment="linux",
        )
        await self.is_ready(info, timeout=self.settings.ready_timeout)
        return info

    def control_endpoint(self, container_name: str, mapped_api_port: int) -> tuple[str, int]:
        if self.settings.docker_network:
            return container_name, 8000
        return "127.0.0.1", mapped_api_port

    async def list(self) -> list[dict[str, Any]]:
        result = await _docker(
            [
                "ps",
                "-a",
                "--filter",
                "label=cua.pool=true",
                "--format",
                "{{json .}}",
            ],
            check=False,
        )
        rows: list[dict[str, Any]] = []
        for line in result.stdout.splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            raw_status = str(item.get("Status", ""))
            if "Paused" in raw_status:
                status = "suspended"
            elif raw_status.startswith("Up"):
                status = "running"
            elif raw_status.startswith("Exited"):
                status = "stopped"
            else:
                status = raw_status.lower() or "unknown"
            rows.append(
                {
                    "name": item.get("Names", ""),
                    "status": status,
                    "image": item.get("Image", ""),
                }
            )
        return rows

    async def _container_exists(self, name: str) -> bool:
        result = await _docker(["container", "inspect", name], check=False)
        return result.returncode == 0

    async def _require_pool_container(self, name: str) -> None:
        result = await _docker(
            ["inspect", "--format", '{{index .Config.Labels "cua.pool"}}', name],
            check=False,
        )
        if result.returncode != 0 or result.stdout.strip().lower() != "true":
            raise ValueError(f"Refusing to operate on non-pool container {name!r}")

    async def _mapped_port(self, name: str, internal_port: int) -> int:
        result = await _docker(
            [
                "inspect",
                "--format",
                f'{{{{(index (index .NetworkSettings.Ports "{internal_port}/tcp") 0).HostPort}}}}',
                name,
            ]
        )
        value = result.stdout.strip()
        if not value.isdigit():
            raise RuntimeError(f"No mapped port for {name}:{internal_port}")
        return int(value)


class CuaDockerBackend:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or Settings.from_env()
        self.runtime = DockerRuntime(self.settings)

    async def create(self, name: str) -> DesktopInfo:
        alias, container_name = self.settings.normalize_name(name)
        existing = await self.list()
        if any(item.container_name == container_name for item in existing):
            raise ValueError(f"Desktop {alias!r} already exists")
        if len(existing) >= self.settings.max_desktops:
            raise RuntimeError(
                f"Desktop limit reached ({self.settings.max_desktops}). "
                "Suspend or destroy one before creating another."
            )
        image = Image.from_registry(self.settings.image)
        await self.runtime.start(image, container_name)
        return await self.info(alias)

    async def list(self) -> list[DesktopInfo]:
        rows = await self.runtime.list()
        result: list[DesktopInfo] = []
        for row in rows:
            container_name = str(row["name"])
            if not container_name.startswith(self.settings.prefix):
                continue
            alias = container_name[len(self.settings.prefix) :]
            result.append(await self._info_from_row(alias, row))
        return result

    async def info(self, name: str) -> DesktopInfo:
        alias, container_name = self.settings.normalize_name(name)
        rows = await self.runtime.list()
        row = next((row for row in rows if row["name"] == container_name), None)
        if row is None:
            raise ValueError(f"Desktop {alias!r} does not exist")
        return await self._info_from_row(alias, row)

    async def _info_from_row(self, alias: str, row: dict[str, Any]) -> DesktopInfo:
        container_name = str(row["name"])
        status = str(row["status"])
        api_port: int | None = None
        vnc_port: int | None = None
        if status in {"running", "suspended"}:
            try:
                api_port = await self.runtime._mapped_port(container_name, 8000)
                vnc_port = await self.runtime._mapped_port(container_name, 6901)
            except (DockerCommandError, RuntimeError):
                pass
        return DesktopInfo(
            name=alias,
            container_name=container_name,
            status=status,
            api_port=api_port,
            vnc_port=vnc_port,
            view_url=_view_url(self.settings.view_host, vnc_port) if vnc_port else None,
            image=str(row.get("image") or self.settings.image),
        )

    @asynccontextmanager
    async def session(self, name: str) -> AsyncIterator[Sandbox]:
        info = await self.info(name)
        if info.status != "running" or info.api_port is None:
            raise RuntimeError(f"Desktop {info.name!r} is not running")
        control_host, control_port = self.runtime.control_endpoint(
            info.container_name,
            info.api_port,
        )
        sandbox = await Sandbox.connect(
            info.container_name,
            http_url=f"http://{control_host}:{control_port}",
            container_name=info.container_name,
            telemetry_enabled=False,
        )
        try:
            yield sandbox
        finally:
            await sandbox.disconnect()

    async def suspend(self, name: str) -> DesktopInfo:
        alias, container_name = self.settings.normalize_name(name)
        await self.runtime.suspend(container_name)
        return await self.info(alias)

    async def resume(self, name: str) -> DesktopInfo:
        alias, container_name = self.settings.normalize_name(name)
        await self.runtime.resume(Image.from_registry(self.settings.image), container_name)
        return await self.info(alias)

    async def destroy(self, name: str) -> None:
        _, container_name = self.settings.normalize_name(name)
        await self.runtime.stop(container_name)

    async def doctor(self) -> dict[str, Any]:
        docker_info = await _docker(["info", "--format", "{{.ServerVersion}}"], check=False)
        image_info = await _docker(["image", "inspect", self.settings.image], check=False)
        return {
            "docker": "ok" if docker_info.returncode == 0 else "unavailable",
            "docker_version": docker_info.stdout.strip() or None,
            "image": self.settings.image,
            "image_status": "ready" if image_info.returncode == 0 else "missing",
            "docker_network": self.settings.docker_network or "host-loopback",
            "max_desktops": self.settings.max_desktops,
            "default_cpus": self.settings.cpus,
            "default_memory_mb": self.settings.memory_mb,
            "active_desktops": len(await self.list()) if docker_info.returncode == 0 else 0,
        }
