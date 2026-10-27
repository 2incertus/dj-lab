"""The existing mesa recorder still archives to O Arquivo and the row plays.

Start A Grade (module 0), record about 3 s off the master bus, arquivar,
then the new row shows in O Arquivo and its tocar actually advances audio.
The export this test made is deleted at the end.
"""

import struct

# observe every Audio() the page makes so the test can read its clock;
# the page itself is driven only through its real buttons
_WATCH_AUDIO = """
(() => {
  const A = window.Audio;
  window.__audios = [];
  window.Audio = function (...a) { const x = new A(...a); window.__audios.push(x); return x; };
  window.Audio.prototype = A.prototype;
})();
"""


def _peak(wav: bytes) -> int:
    pcm = wav[44:]
    n = len(pcm) // 2
    return max(abs(v) for v in struct.unpack(f"<{n}h", pcm[:n * 2])) if n else 0


def test_mesa_record_arquivar_and_play(authed_context, api, base_url):
    before = {x["file"] for x in api.get("/api/mesa/exports").json()}
    made = None
    page = authed_context.new_page()
    page.add_init_script(_WATCH_AUDIO)
    try:
        page.goto(f"{base_url}/mesa")
        play = page.locator('.station[data-mod="0"] [data-a=play]')
        play.wait_for(state="visible", timeout=15000)
        play.click()
        page.locator("#mesa [data-m=rec]").click()
        page.wait_for_timeout(3200)
        page.locator("#mesa [data-m=rec]").click()
        arq = page.locator("#mesa [data-m=arq]")
        arq.wait_for(state="visible", timeout=5000)
        with page.expect_response(lambda r: "/api/mesa/export?name=sessao" in r.url) as resp:
            arq.click()
        assert resp.value.ok
        made = resp.value.json()["file"]
        assert made not in before and made.startswith("sessao-") and made.endswith(".wav")
        page.wait_for_function("t => document.querySelector('#mesa [data-m=arq]').textContent.trim() === t",
                               arg="arquivada", timeout=5000)
        page.locator("#mesa [data-m=stopall]").click()

        # the take is about 3 s of real sound, not silence
        listing = {x["file"]: x for x in api.get("/api/mesa/exports").json()}
        assert 2.0 <= listing[made]["dur"] <= 5.0
        wav = api.get(f"/api/mesa/export/{made}")
        assert wav.headers["content-type"] == "audio/wav"
        assert _peak(wav.body()) > 1000

        # the row is in O Arquivo, labelled without the extension
        row = page.locator(".arq-row", has=page.locator(f'[data-arq-play="{made}"]'))
        row.wait_for(state="visible", timeout=5000)
        assert row.locator("b").inner_text().strip() == made[:-len(".wav")]

        # tocar plays it: the Audio it makes points at the export and its clock moves
        row.locator(f'[data-arq-play="{made}"]').click()
        page.wait_for_function(
            """f => (window.__audios || []).some(a =>
                 a.src.endsWith('/api/mesa/export/' + encodeURIComponent(f))
                 && !a.paused && a.currentTime > 0.5)""",
            arg=made, timeout=10000)
        assert row.locator(f'[data-arq-play="{made}"]').inner_text().strip() == "parar"
        row.locator(f'[data-arq-play="{made}"]').click()
    finally:
        page.close()
        if made:
            api.delete(f"/api/mesa/export/{made}")
    after = {x["file"] for x in api.get("/api/mesa/exports").json()}
    assert made not in after
