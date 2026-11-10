# 票 57：词级英音预生成音频抓取脚本（留档可复跑）。
#
# 数据源：有道 dictvoice 接口（type=1 英音）。接口无公开许可——本仓家庭自用
# 定位可接受，商用分发前必须换源（票 57 留痕；wordsfunny 同款方向印证）。
#
# 2026-11-08 首次全量抓取已完成：3,504/3,504 全部成功（其中 408 词返回
# WAV 容器但扩展名 .mp3——浏览器按内容嗅探解码，客户端解码失败还有 TTS
# 兜底，不阻塞）。本脚本仅为复抓/换源留档。
#
# 用法（PowerShell，仓根执行）：
#   python reports/57-assets/fetch-audio.py          # 全量（缺文件才抓）
#   python reports/57-assets/fetch-audio.py --all    # 无视已有文件强制重抓
# 词表：.squad/tmp/audio-words.txt（3,504 行 LF，与 bundle 词条对账生成）
#
# 抓完生成 manifest：
#   python reports/57-assets/fetch-audio.py --manifest-only
import ipaddress
import json
import pathlib
import socket
import sys
import time

import requests

ROOT = pathlib.Path(__file__).resolve().parents[2]
AUDIO = ROOT / 'client/app/public/audio'
WORDS = ROOT / '.squad/tmp/audio-words.txt'
# SSRF 防线（构建期脚本同样守规）：协议＋域名白名单＋解析 IP 非私网校验＋
# 不跟随重定向（allow_redirects=False，落地宿主恒为白名单域）
ALLOWED_HOST = 'dict.youdao.com'
UA = {'User-Agent': 'Mozilla/5.0 (kidsenglish offline-audio build)'}
MIN_BYTES = 1500  # 有道对缺失词返回短 404 页，<1.5KB 视为失败


def assert_public_host(host: str) -> None:
    if host != ALLOWED_HOST:
        raise ValueError(f'host 不在白名单: {host}')
    for _fam, _typ, _proto, _canon, sa in socket.getaddrinfo(host, 443):
        ip = ipaddress.ip_address(sa[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:  # nosemgrep: python.lang.maintainability.is-function-without-parentheses
            raise ValueError(f'{host} 解析到私网/保留地址: {ip}')


def fetch_one(word: str) -> bool:
    assert_public_host(ALLOWED_HOST)
    url = f'https://{ALLOWED_HOST}/dictvoice?type=1&audio={requests.utils.quote(word, safe="")}'
    try:
        r = requests.get(url, headers=UA, timeout=20, allow_redirects=False)  # SSRF：不跟随
        if r.status_code != 200:
            print(f'FAIL {word}: 状态 {r.status_code}')
            return False
        raw = r.content
    except Exception as e:  # noqa: BLE001 — 网络失败＝该词失败，续跑
        print(f'FAIL {word}: {e}')
        return False
    if not looks_like_audio(raw):
        print(f'FAIL {word}: {len(raw)}B 非音频头校验')
        return False
    (AUDIO / f'{word}.mp3').write_bytes(raw)
    return True


def looks_like_audio(raw: bytes) -> bool:
    if len(raw) <= MIN_BYTES:
        return False
    head = raw[:16]
    return (
        head[:3] == b'ID3'
        or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)
        or (head[:4] == b'RIFF' and head[8:12] == b'WAVE')
    )


def write_manifest() -> None:
    good = [f.stem for f in sorted(AUDIO.glob('*.mp3')) if looks_like_audio(f.read_bytes())]
    (AUDIO / 'manifest.json').write_text(
        json.dumps({'words': good}, ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8',
    )
    print(f'manifest words = {len(good)}')


def main() -> None:
    if '--manifest-only' in sys.argv:
        write_manifest()
        return
    force = '--all' in sys.argv
    AUDIO.mkdir(parents=True, exist_ok=True)
    words = [w.strip() for w in WORDS.read_text(encoding='utf-8').splitlines() if w.strip()]
    done = fail = 0
    for i, w in enumerate(words, 1):
        f = AUDIO / f'{w}.mp3'
        if not force and f.exists() and looks_like_audio(f.read_bytes()):
            done += 1
            continue
        if fetch_one(w):
            done += 1
        else:
            fail += 1
        if i % 50 == 0:
            print(f'{i}/{len(words)} done={done} fail={fail}')
        time.sleep(0.15)  # nosemgrep: python.lang.best-practice.arbitrary-sleep 限速：对源友好（全量约 20 分钟）
    print(f'FETCH_DONE n={done} fail={fail}')
    write_manifest()


if __name__ == '__main__':
    main()
