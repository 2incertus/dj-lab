"""The /cabine/proof measurements panel: the numbers the iPhone checkpoint
(Task 6) reads off the phone. Chromium only (ruling R8): here they only have
to come out, and come out right where Chromium's answer is known."""

import pytest

pytestmark = pytest.mark.usefixtures("carried")


def test_measurements_panel_reports_the_checkpoint_numbers(proof_page, carried):
    page = proof_page
    page.click("#cab-start")
    page.wait_for_function("() => window.cabineProof.decks.length === 2")
    r = page.evaluate("async (file) => await window.cabineProof.measure.run(file)", carried["click120"])
    print(f"\nmeasure: {r}")
    assert r["sampleRate"] > 0 and r["baseLatencyMs"] is not None, r
    assert "outputLatencyMs" in r, r
    # decoded vs expected from the library's exact source frame count
    assert r["samples"] == 20 * 44100, r                 # the 20 s click120 fixture
    assert abs(r["expectedFrames"] - 20 * r["sampleRate"]) < 1, r
    assert abs(r["extraFrames"]) <= 2, f"Chromium trims the LAME delay: {r}"
    assert abs(r["headOffsetSamples44k"]) <= 2, r
    # first click vs the grid's first beat (0.25 s), through the voice
    assert abs(r["onsetMinusGridMs"]) < 1, r
    # 200 pings through DeckVoice.sync()
    assert r["pings"]["n"] == 200, r
    # performance.now() is coarse (0.1 ms in Chromium): a median of 0 is a real reading
    assert 0 <= r["pings"]["medianMs"] <= r["pings"]["maxMs"] < 1000, r
    assert set(r["recorderTypes"]) == {"audio/webm;codecs=opus", "audio/mp4", "audio/mp4;codecs=mp4a.40.2"}, r
    assert r["recorderTypes"]["audio/webm;codecs=opus"] is True, r
    assert r["memory"].startswith("heap") , r
    text = page.inner_text("#cab-meas-out")
    for word in ("sampleRate", "outputLatency", "decoded", "first onset", "round trip", "MediaRecorder", "memory"):
        assert word in text, f"{word} missing from the panel: {text}"


def test_measurements_recording_offers_crash_and_stopped_files(proof_page):
    page = proof_page
    page.click("#cab-start")
    page.wait_for_function("() => window.cabineProof.decks.length === 2")
    r = page.evaluate("async () => await window.cabineProof.measure.record(2, 500)")
    print(f"\nrecord: {r}")
    assert r["mimeType"].startswith("audio/webm"), r
    assert r["crash"]["chunks"] >= 3 and r["crash"]["bytes"] > 0, r
    assert r["stopped"]["chunks"] >= r["crash"]["chunks"], r
    assert r["stopped"]["bytes"] >= r["crash"]["bytes"], r
    links = page.eval_on_selector_all("#cab-meas-files a",
                                      "els => els.map(a => [a.textContent, a.download, a.href.slice(0, 5)])")
    assert len(links) == 2, links
    assert "crash" in links[0][1] and "no stop()" in links[0][0], links
    assert "stopped" in links[1][1], links
    assert all(h == "blob:" for _, _, h in links), links
