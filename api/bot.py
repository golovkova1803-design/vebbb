import base64
import json
import os
from pathlib import Path
from urllib.parse import urlencode
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

# Токен берется из настроек Vercel (Environment Variables) или можно вписать прямо сюда вторым параметром
BOT_TOKEN = os.environ.get("BOT_TOKEN", "ТВОЙ_ТОКЕН_БОТА")
OWNER_TG_ID = 5881813602  # @darxxx1zq
TG_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

BASE_DIR = Path(__file__).resolve().parent.parent
WELCOME_IMG = BASE_DIR / "welcome.jpg"


def hex_to_signed_int(hex_str: str) -> int:
    clean = (hex_str or "000000").lstrip("#")[:6].zfill(6)
    val = int("ff" + clean, 16)
    return val - 0x100000000 if val >= 0x80000000 else val


def generate_attheme_from_deeplink(parts: list[str]) -> bytes:
    bg = hex_to_signed_int(parts[2] if len(parts) > 2 else "060d0b")
    hdr = hex_to_signed_int(parts[3] if len(parts) > 3 else "0b1613")
    out_b = hex_to_signed_int(parts[4] if len(parts) > 4 else "0d9468")
    in_b = hex_to_signed_int(parts[5] if len(parts) > 5 else "11221d")
    acc = hex_to_signed_int(parts[6] if len(parts) > 6 else "10b981")
    med = hex_to_signed_int(parts[7] if len(parts) > 7 else "34d399")
    dlg = hex_to_signed_int(parts[8] if len(parts) > 8 else "10b981")
    chk = hex_to_signed_int(parts[9] if len(parts) > 9 else "a7f3d0")
    txt = hex_to_signed_int("f4f4f5")

    keys = {
        "windowBackgroundWhite": bg, "chat_wallpaper": bg, "actionBarDefault": hdr,
        "actionBarDefaultTitle": txt, "actionBarDefaultSubtitle": acc, "chats_background": bg,
        "chats_name": txt, "chats_secretName": chk, "chats_secretIcon": chk, "chat_lockIcon": chk,
        "chats_sentCheck": chk, "chats_sentReadCheck": chk, "chats_unreadCounter": acc,
        "chat_inBubble": in_b, "chat_outBubble": out_b, "chat_messageTextIn": txt, "chat_messageTextOut": txt,
        "chat_outSentCheck": chk, "chat_outSentCheckRead": chk,
        "chat_inVoiceSeekbar": med, "chat_inVoiceSeekbarSelected": med, "chat_inVoiceSeekbarFill": med,
        "chat_outVoiceSeekbar": med, "chat_outVoiceSeekbarSelected": med, "chat_outVoiceSeekbarFill": med,
        "chat_inAudioSeekbar": med, "chat_inAudioSeekbarSelected": med, "chat_inAudioSeekbarFill": med,
        "chat_outAudioSeekbar": med, "chat_outAudioSeekbarSelected": med, "chat_outAudioSeekbarFill": med,
        "chat_inAudioTitleText": txt, "chat_outAudioTitleText": txt,
        "chat_inFileBg": med, "chat_outFileBg": med, "chat_inLoader": med, "chat_outLoader": med,
        "inappPlayerTitle": txt, "inappPlayerPerformer": med, "inappPlayerPlayPause": med,
        "dialogButton": dlg, "dialogTextBlue": dlg, "windowBackgroundWhiteBlueText": dlg,
        "windowBackgroundWhiteBlueButton": dlg, "picker_enabledButton": dlg,
        "chat_messagePanelBackground": hdr, "chat_messagePanelText": txt, "chat_messagePanelSend": acc
    }
    return ("\n".join(f"{k}={v}" for k, v in keys.items()) + "\n").encode("utf-8")


# 1. АВТОМАТИЧЕСКАЯ ПРИВЯЗКА БОТА К VERCEL В 1 КЛИК
@app.route("/api/setup", methods=["GET"])
def setup_webhook():
    host = request.headers.get("x-forwarded-host") or request.host
    webhook_url = f"https://{host}/api/webhook"
    r = requests.post(f"{TG_API}/setWebhook", json={"url": webhook_url})
    return jsonify({
        "status": "Вебхук установлен! Теперь открой бота в Telegram и нажми /start",
        "webhook_url": webhook_url,
        "telegram_response": r.json()
    })


# 2. МГНОВЕННАЯ ДОСТАВКА ФАЙЛА ТЕМЫ ИЛИ ЯЗЫКА ИЗ САЙТА В ЧАТ ТЕЛЕГРАМ
@app.route("/api/deliver-package", methods=["POST"])
def deliver_package():
    user_id = request.form.get("user_id") or str(OWNER_TG_ID)
    pkg_name = request.form.get("name", "Custom")
    pkg_kind = request.form.get("kind", "theme")
    uploaded = request.files.get("file")

    if not uploaded:
        return jsonify({"ok": False, "error": "no_file"}), 400

    filename = uploaded.filename or ("lang.xml" if pkg_kind == "lang" else "theme.attheme")
    file_bytes = uploaded.read()

    caption = (
        f"🗣 <b>Языковой пакет «{pkg_name}» готов!</b>\nНажмите на файл выше и выберите «Применить локализацию»."
        if pkg_kind == "lang" else
        f"🎨 <b>Тема «{pkg_name}» готова!</b>\nНажмите на файл выше — сразу откроется системное окно просмотра и применения темы в Telegram."
    )

    send_res = requests.post(
        f"{TG_API}/sendDocument",
        data={"chat_id": user_id, "caption": caption, "parse_mode": "HTML"},
        files={"document": (filename, file_bytes)}
    ).json()

    direct_url = None
    if send_res.get("ok"):
        file_id = send_res.get("result", {}).get("document", {}).get("file_id")
        if file_id:
            f_info = requests.get(f"{TG_API}/getFile", params={"file_id": file_id}).json()
            file_path = f_info.get("result", {}).get("file_path")
            if file_path:
                direct_url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}"

    return jsonify({"ok": True, "direct_url": direct_url})


# 3. ОБРАБОТЧИК КОМАНДЫ /START В БОТЕ (С КАРТИНКОЙ ПРИВЕТСТВИЯ)
@app.route("/api/webhook", methods=["POST"])
def telegram_webhook():
    update = request.get_json(silent=True) or {}
    msg = update.get("message")
    if not msg:
        return jsonify({"ok": True})

    chat_id = msg.get("chat", {}).get("id")
    first_name = msg.get("from", {}).get("first_name", "друг")
    text = (msg.get("text") or "").strip()

    if text.startswith("/start"):
        parts = text.split(maxsplit=1)
        arg = parts[1].strip() if len(parts) > 1 else ""

        # Если нажали быструю установку темы через DeepLink
        if arg.startswith("t_"):
            raw_bytes = generate_attheme_from_deeplink(arg.split("_"))
            requests.post(
                f"{TG_API}/sendDocument",
                data={
                    "chat_id": chat_id,
                    "caption": "🎨 <b>Ваша тема скомпилирована!</b>\nНажмите на файл выше — сразу откроется окно просмотра и применения темы в Telegram.",
                    "parse_mode": "HTML"
                },
                files={"document": ("tg_studio_theme.attheme", raw_bytes)}
            )
            return jsonify({"ok": True})

        # Если нажали быструю установку языка через DeepLink
        if arg.startswith("l_"):
            b64 = arg[2:].replace("-", "+").replace("_", "/")
            b64 += "=" * ((4 - len(b64) % 4) % 4)
            try:
                d = json.loads(base64.b64decode(b64).decode("utf-8"))
            except Exception:
                d = {"n": "Custom", "o": "в сети", "t": "печатает...", "m": "Сообщение..."}
            xml_bytes = (
                '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
                f'    <string name="LanguageName">{d.get("n", "Custom")}</string>\n'
                f'    <string name="Online">{d.get("o", "в сети")}</string>\n'
                f'    <string name="Typing">{d.get("t", "печатает...")}</string>\n'
                f'    <string name="Message">{d.get("m", "Сообщение...")}</string>\n'
                f'    <string name="TypeMessage">{d.get("m", "Сообщение...")}</string>\n'
                '</resources>\n'
            ).encode("utf-8")
            requests.post(
                f"{TG_API}/sendDocument",
                data={
                    "chat_id": chat_id,
                    "caption": "🗣 <b>Ваш языковой пакет готов!</b>\nНажмите на файл выше и выберите «Применить локализацию».",
                    "parse_mode": "HTML"
                },
                files={"document": ("tg_studio_lang.xml", xml_bytes)}
            )
            return jsonify({"ok": True})

        # Стандартное приветствие /start с картинкой welcome.jpg
        host = request.headers.get("x-forwarded-host") or request.host
        me = requests.get(f"{TG_API}/getMe").json().get("result", {})
        bot_username = me.get("username", "DarxyNN_bot")
        app_url = f"https://{host}/?{urlencode({'bot': bot_username})}"

        kb = {"inline_keyboard": [[{"text": "🎨 Запустить TG Studio", "web_app": {"url": app_url}}]]}
        caption = (
            f"Привет, <b>{first_name}</b>! 👋\n\n"
            "Ты находишься в <b>TG Studio</b> — профессиональном конструкторе кастомизации Telegram.\n\n"
            "<b>Зачем ты здесь и что умеет приложение:</b>\n"
            "• 🎨 <b>Создание тем без пропусков:</b> настраивай 178 цветовых ключей (бабблы, дорожки голосовых, кнопки песен, галочки и закрытые чаты).\n"
            "• 🖼 <b>Редактор своих обоев:</b> загружай любой фон, масштабируй его пальцем — и он автоматически вшивается внутрь файла темы.\n"
            "• 🗣 <b>Собственные языки:</b> меняй системные надписи («в сети», «печатает...», кнопки диалогов) под свой стиль.\n"
            "• ⚡ <b>Мгновенная установка:</b> бот сразу присылает готовый файл в этот чат — остаётся только нажать «Применить».\n\n"
            "👇 <b>Переходи в наше приложение по кнопке ниже:</b>"
        )

        if WELCOME_IMG.exists():
            with open(WELCOME_IMG, "rb") as photo_file:
                requests.post(
                    f"{TG_API}/sendPhoto",
                    data={"chat_id": chat_id, "caption": caption, "parse_mode": "HTML", "reply_markup": json.dumps(kb)},
                    files={"photo": ("welcome.jpg", photo_file.read())}
                )
        else:
            requests.post(
                f"{TG_API}/sendMessage",
                json={"chat_id": chat_id, "text": caption, "parse_mode": "HTML", "reply_markup": kb}
            )

    return jsonify({"ok": True})


@app.route("/api/admin/users", methods=["GET"])
def admin_users():
    return jsonify({"ok": True, "users": []})


@app.route("/api/admin/action", methods=["POST"])
def admin_action():
    return jsonify({"ok": True})