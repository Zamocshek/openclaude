"""
Automated refactoring script for main.py
Replaces global `client` with `c = await _get_client(account_id)` in all @mcp.tool functions.
"""
import re
import sys

def refactor(filepath: str) -> None:
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    lines = content.split("\n")
    total_lines = len(lines)

    # Track which functions already use _get_client
    already_ok = set()
    needs_fix = []

    # Find all async def functions that are MCP tools
    # Pattern: @mcp.tool(...) possibly with @tool_timeout, then async def name(...)
    i = 0
    while i < total_lines:
        line = lines[i]

        # Detect @mcp.tool decorator
        if "@mcp.tool" in line:
            # Gather decorator lines until we find async def
            decorator_start = i
            j = i + 1
            while j < total_lines and not lines[j].strip().startswith("async def "):
                j += 1

            if j >= total_lines:
                i = j
                continue

            func_line = lines[j]
            func_line_num = j

            # Extract function name
            m = re.match(r'\s*async def (\w+)\(', func_line)
            if not m:
                i = j + 1
                continue
            func_name = m.group(1)

            # Find the end of this function (next function or decorator or end of file)
            func_end = j + 1
            indent_level = len(func_line) - len(func_line.lstrip())
            while func_end < total_lines:
                next_line = lines[func_end]
                stripped = next_line.strip()

                # Skip empty lines
                if not stripped:
                    func_end += 1
                    continue

                # If we hit a line at same or lower indent that's a new def or decorator
                curr_indent = len(next_line) - len(next_line.lstrip())
                if curr_indent <= indent_level and (stripped.startswith("@") or stripped.startswith("async def ") or stripped.startswith("def ")):
                    break
                func_end += 1

            # Get the function body
            func_body = "\n".join(lines[func_line_num:func_end])

            # Check if it already uses _get_client
            if "_get_client" in func_body:
                already_ok.add(func_name)
                i = func_end
                continue

            # Check if it uses global `client` (not in comments/strings)
            uses_client = False
            for bl in lines[func_line_num:func_end]:
                stripped_bl = bl.strip()
                if stripped_bl.startswith("#"):
                    continue
                # Match client. or client( but not _client or "client"
                if re.search(r'(?<![_\w])client(?:\.|\()', stripped_bl):
                    uses_client = True
                    break

            if not uses_client:
                i = func_end
                continue

            needs_fix.append({
                "name": func_name,
                "decorator_start": decorator_start,
                "func_line_num": func_line_num,
                "func_end": func_end,
                "func_line": func_line,
            })

            i = func_end
        else:
            i += 1

    print(f"Already OK (have _get_client): {len(already_ok)}")
    print(f"Need fixing: {len(needs_fix)}")

    if not needs_fix:
        print("Nothing to fix!")
        return

    # Sort in reverse order so line numbers stay valid as we modify
    needs_fix.sort(key=lambda x: x["func_line_num"], reverse=True)

    for info in needs_fix:
        func_name = info["name"]
        func_line_num = info["func_line_num"]
        func_end = info["func_end"]
        func_line = lines[func_line_num]

        print(f"  Fixing: {func_name} (line {func_line_num + 1})")

        # Step 1: Add account_id parameter to function signature
        # Find the closing parenthesis of the function signature
        sig_lines = []
        sig_start = func_line_num
        paren_depth = 0
        sig_end = sig_start
        for k in range(sig_start, min(func_end, sig_start + 20)):
            sig_lines.append(lines[k])
            paren_depth += lines[k].count("(") - lines[k].count(")")
            if paren_depth <= 0:
                sig_end = k
                break

        sig_text = "\n".join(sig_lines)

        # Check if account_id already in signature
        if "account_id" not in sig_text:
            # Find the closing ) -> str: part
            # Add account_id before the closing paren
            if ") -> str:" in sig_text:
                # Simple case: signature on one or few lines
                # Find the last ) -> str:
                for k in range(sig_end, sig_start - 1, -1):
                    if ") -> str:" in lines[k]:
                        lines[k] = lines[k].replace(") -> str:", ", account_id: Optional[str] = None) -> str:", 1)
                        # Handle case where params are empty: () -> str:
                        lines[k] = lines[k].replace("(, ", "(")
                        break
            elif ") -> str :" in sig_text:
                for k in range(sig_end, sig_start - 1, -1):
                    if ") -> str :" in lines[k]:
                        lines[k] = lines[k].replace(") -> str :", ", account_id: Optional[str] = None) -> str:", 1)
                        lines[k] = lines[k].replace("(, ", "(")
                        break

        # Step 2: Add c = await _get_client(account_id) after try:
        # Find the first "try:" after function def
        insert_done = False
        for k in range(func_line_num + 1, func_end):
            stripped = lines[k].strip()
            if stripped == "try:":
                indent = " " * (len(lines[k]) - len(lines[k].lstrip()) + 4)
                lines.insert(k + 1, f"{indent}c = await _get_client(account_id)")
                func_end += 1
                insert_done = True
                break

        if not insert_done:
            # No try: block, add after docstring
            in_docstring = False
            for k in range(func_line_num + 1, func_end):
                stripped = lines[k].strip()
                if '"""' in stripped:
                    if in_docstring:
                        # End of docstring
                        indent = " " * (len(lines[func_line_num]) - len(lines[func_line_num].lstrip()) + 4)
                        lines.insert(k + 1, f"{indent}c = await _get_client(account_id)")
                        func_end += 1
                        insert_done = True
                        break
                    elif stripped.count('"""') >= 2:
                        # Single-line docstring
                        indent = " " * (len(lines[func_line_num]) - len(lines[func_line_num].lstrip()) + 4)
                        lines.insert(k + 1, f"{indent}c = await _get_client(account_id)")
                        func_end += 1
                        insert_done = True
                        break
                    else:
                        in_docstring = True

        # Step 3: Replace `client.` and `client(` with `c.` and `c(` in function body
        start_replace = func_line_num + 1
        for k in range(start_replace, func_end):
            stripped = lines[k].strip()
            if stripped.startswith("#"):
                continue
            # Replace client. with c. and client( with c( but not _client or other_client
            lines[k] = re.sub(r'(?<![_\w])client\.', 'c.', lines[k])
            lines[k] = re.sub(r'(?<![_\w])client\(', 'c(', lines[k])

    # Write back
    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"\nDone! Fixed {len(needs_fix)} functions.")


if __name__ == "__main__":
    filepath = sys.argv[1] if len(sys.argv) > 1 else "main.py"
    refactor(filepath)
