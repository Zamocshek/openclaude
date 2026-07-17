# Internal 3DS Sandbox / Security Demo — Configuration
import os

SECRET_KEY = os.environ.get("FLASK_SECRET", os.urandom(32).hex())
BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
ADMIN_IDS = [x.strip() for x in os.environ.get("ADMIN_IDS", "").split(",") if x.strip()]
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "5000"))
