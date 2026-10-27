"""A Cabine crate (A Caixa) in a portrait phone viewport: search, pull,
carry to the phone, remove, grid pending, grid fixes, grid everything.

Needs dj-lab-dev running with CABINE_FAKE_INTAKE=1 (dev-env.md)."""

import json
import time

import pytest
from playwright.sync_api import expect

pytestmark = pytest.mark.usefixtures("crate_tracks")

CARRY_TIMEOUT = 60_000


def row(page, file):
    return page.locator(f'.cab-track[data-file="{file}"]')


def carry(page, file):
    r = row(page, file)
    r.locator(".cab-carry").click()
    expect(r.locator(".cab-badge-phone")).to_have_text("on phone", timeout=CARRY_TIMEOUT)
    return r


def entry(page, file):
    return page.evaluate("(f) => window.cabine.store.getEntry(f)", file)


def search(page, tab, q):
    page.click(f'.cab-tab[data-tab="{tab}"]')
    page.fill("#cab-q", q)
    page.press("#cab-q", "Enter")
    expect(page.locator("#cab-results .cab-result").first).to_be_visible(timeout=15_000)


def test_carry_then_offline_list_still_shows(crate_page, crate_tracks, phone_context):
    page, file = crate_page, crate_tracks["a"]
    carry(page, file)
    stored = page.evaluate("""async (f) => {
        const t = await window.cabine.store.getTrack(f);
        return {mp3: t.mp3.byteLength, peaks: t.peaks.byteLength, bpm: t.grid && t.grid.bpm,
                samples: t.meta.samples, bytes: t.bytes};
    }""", file)
    assert stored["mp3"] > 50_000 and stored["peaks"] > 12, stored
    assert stored["bpm"] == 125.0 and stored["samples"] == 10 * 44100, stored
    assert stored["bytes"] == stored["mp3"] + stored["peaks"], stored

    # the phone loses its signal: the crate still lists what it carries
    phone_context.set_offline(True)
    page.evaluate("() => window.cabine.crate.refresh()")
    expect(page.locator("#cab-offline")).to_be_visible()
    expect(row(page, file).locator(".cab-badge-phone")).to_have_text("on phone")
    expect(page.locator(".cab-track")).to_have_count(1)
    phone_context.set_offline(False)

    # a fresh start with the server out of reach: the carried track is still there
    # (the page shell itself loading with no signal is Task 11's service worker)
    page.route("**/api/**", lambda route: route.abort())
    page.reload()
    page.wait_for_function("() => window.cabine && window.cabine.crate")
    page.evaluate("() => window.cabine.crate.ready")
    expect(page.locator("#cab-offline")).to_be_visible()
    expect(row(page, file).locator(".cab-badge-phone")).to_have_text("on phone")
    assert entry(page, file)["grid"]["bpm"] == 125.0


def test_set_flagged_not_pullable(crate_page):
    page = crate_page
    expect(page.locator("#cab-job")).to_be_hidden()         # no job box until a job runs
    for tab in ("soundcloud", "youtube"):
        search(page, tab, "techno")
        sets = page.locator("#cab-results .cab-too-long")
        expect(sets.first).to_contain_text("that's a set, not a track")
        assert sets.count() >= 1
        assert sets.locator(".cab-pull").count() == 0, f"{tab}: a set has a pull button"
        tracks = page.locator("#cab-results .cab-result:not(.cab-too-long)")
        assert tracks.count() >= 1
        for i in range(tracks.count()):
            expect(tracks.nth(i).locator(".cab-pull")).to_be_visible()
            expect(tracks.nth(i)).not_to_contain_text("that's a set")


def test_spotify_pick_searches_youtube_for_the_upload(crate_page):
    page = crate_page
    search(page, "spotify", "tool 126")
    first = page.locator("#cab-results .cab-result").first
    expect(first.locator(".cab-pull")).to_have_count(0)        # Spotify serves no audio
    first.locator(".cab-pick").click()
    expect(page.locator('.cab-tab[data-tab="youtube"]')).to_have_attribute("aria-selected", "true")
    assert page.input_value("#cab-q") == "Cabine E2E Tool 126"
    expect(page.locator("#cab-context")).to_contain_text("Pick the YouTube upload")
    expect(page.locator("#cab-results .cab-pull").first).to_be_visible()
    # no account tabs: only name search
    assert page.locator(".cab-tab").all_inner_texts() == ["YouTube", "SoundCloud", "Spotify"]
    assert "liked" not in page.inner_text(".cab-search").lower()


def test_pull_lands_in_the_crate(crate_page):
    page = crate_page
    search(page, "youtube", "tool")
    item = page.locator("#cab-results .cab-result", has_text="Cabine E2E Tool 126")
    item.locator(".cab-pull").click()
    expect(page.locator("#cab-job")).to_contain_text("done", timeout=120_000)
    expect(row(page, "cabine-e2e__tool-126.wav")).to_be_visible()


def test_grid_fix_roundtrip(crate_page, crate_tracks, api):
    page, file = crate_page, crate_tracks["a"]
    r = carry(page, file)
    r.locator(".cab-grid-open").click()
    sheet = page.locator("#cab-sheet")
    expect(sheet).to_be_visible()
    expect(sheet.locator("#cab-sheet-grid")).to_contain_text("125.00 BPM")
    sheet.locator('[data-op="double"]').click()
    expect(sheet.locator("#cab-sheet-msg")).to_have_text("saved")
    expect(sheet.locator("#cab-sheet-grid")).to_contain_text("250.00 BPM")
    server = api.get(f"/api/cabine/grid?file={file}").json()
    assert server["bpm"] == 250.0 and server["fixed"] is True, server
    carried = entry(page, file)["grid"]
    assert carried == server, (carried, server)

    sheet.locator('[data-nudge="-10"]').click()
    expect(sheet.locator("#cab-sheet-msg")).to_have_text("saved")
    server2 = api.get(f"/api/cabine/grid?file={file}").json()
    assert server2["first_beat_s"] == pytest.approx(server["first_beat_s"] - 0.010, abs=1e-6)
    assert entry(page, file)["grid"] == server2


def test_beat_one_tap_through_the_carried_copy(crate_page, crate_tracks, api):
    page, file = crate_page, crate_tracks["a"]
    r = carry(page, file)
    r.locator(".cab-grid-open").click()
    sheet = page.locator("#cab-sheet")
    sheet.locator("#cab-listen").click()
    expect(sheet.locator("#cab-listen")).to_have_text("pause", timeout=20_000)
    # through the deck path: a worklet deck playing the carried mp3
    time.sleep(1.4)
    sheet.locator("#cab-beat1").click()
    expect(sheet.locator("#cab-sheet-msg")).to_contain_text("beat 1 set at")
    tapped = float(sheet.get_attribute("data-tapped"))
    assert 0.8 < tapped < 3.0, tapped
    g = api.get(f"/api/cabine/grid?file={file}").json()
    period = 60.0 / 125.0
    # snapped onto the grid, at the beat nearest the tap
    k = (g["downbeat_s"] - 0.2) / period
    assert abs(k - round(k)) < 1e-4, g
    assert abs(g["downbeat_s"] - tapped) <= period / 2 + 1e-6, (g, tapped)
    assert g["downbeat_s"] != 0.2
    assert entry(page, file)["grid"]["downbeat_s"] == g["downbeat_s"]
    sheet.locator("#cab-sheet-done").click()
    expect(sheet).to_be_hidden()


def test_remove_frees_storage(crate_page, crate_tracks):
    page, file = crate_page, crate_tracks["a"]
    r = carry(page, file)
    storage = page.locator("#cab-storage")
    expect(storage).to_contain_text("1 track on the phone")
    carried = int(storage.get_attribute("data-carried-bytes"))
    assert carried > 50_000
    usage_before = page.evaluate("async () => (await navigator.storage.estimate()).usage")
    r.locator(".cab-remove").click()            # first tap only asks
    expect(r.locator(".cab-remove")).to_have_text("tirar?")
    r.locator(".cab-remove").click()            # second tap within 3 s confirms
    expect(r.locator(".cab-badge-phone")).to_have_count(0)
    expect(r.locator(".cab-carry")).to_be_visible()
    expect(storage).to_contain_text("0 tracks on the phone, 0 MB")
    assert storage.get_attribute("data-carried-bytes") == "0"
    assert page.evaluate("async () => (await window.cabine.store.listTracks()).length") == 0
    assert page.evaluate("async (f) => await window.cabine.store.getTrack(f)", file) is None
    usage_after = page.evaluate("async () => (await navigator.storage.estimate()).usage")
    print(f"\nstorage estimate: {usage_before} -> {usage_after} bytes (carried {carried})")


def test_one_tap_on_tirar_does_not_remove(crate_page, crate_tracks):
    page, file = crate_page, crate_tracks["a"]
    r = carry(page, file)
    r.locator(".cab-remove").click()
    expect(r.locator(".cab-remove")).to_have_text("tirar?")
    # no second tap: after 3 s the button goes back and the track stays
    expect(r.locator(".cab-remove")).to_have_text("tirar", timeout=5_000)
    expect(r.locator(".cab-badge-phone")).to_have_text("on phone")
    assert page.evaluate("async (f) => !!(await window.cabine.store.getTrack(f))", file)


def test_carry_error_text_is_escaped(crate_page, crate_tracks):
    page, file = crate_page, crate_tracks["a"]
    page.route("**/api/cabine/carry?*", lambda route: route.fulfill(
        status=500, content_type="application/json",
        body=json.dumps({"detail": '<img src="x" class="cab-xss">broken'})))
    row(page, file).locator(".cab-carry").click()
    job = page.locator("#cab-job")
    expect(job).to_contain_text('<img src="x" class="cab-xss">broken')
    expect(job.locator("img")).to_have_count(0)
    page.unroute("**/api/cabine/carry?*")


def test_carry_during_job_marks_grid_pending_then_resolves(crate_page, crate_tracks):
    page, file = crate_page, crate_tracks["nogrid"]
    hold = crate_tracks["hold"]
    hold.write_text("hold")
    try:
        search(page, "youtube", "slow")
        item = page.locator("#cab-results .cab-result", has_text="Cabine E2E Slow Upload")
        item.locator(".cab-pull").click()
        expect(page.locator("#cab-job")).to_contain_text("holding the job lock", timeout=15_000)

        r = carry(page, file)
        expect(r.locator(".cab-badge-pending")).to_have_text("grade pendente")
        assert entry(page, file)["grid"] is None
        assert page.evaluate("async (f) => (await window.cabine.store.getTrack(f)).mp3.byteLength", file) > 10_000
    finally:
        hold.unlink(missing_ok=True)
    # the pull ends, refreshGrids asks again: a grid job runs and fills it in
    expect(page.locator("#cab-job")).to_contain_text("done", timeout=30_000)
    expect(r.locator(".cab-badge-pending")).to_have_count(0, timeout=120_000)
    g = entry(page, file)["grid"]
    assert g and g["bpm"] == pytest.approx(124.0, abs=0.5), g
    assert (crate_tracks["techno"] / (file + ".grid.json")).exists()


def test_grid_all_job_grids_ungridded_tracks(crate_page, crate_tracks):
    page, file = crate_page, crate_tracks["nogrid"]
    sidecar = crate_tracks["techno"] / (file + ".grid.json")
    assert not sidecar.exists()
    posted = []

    # the dev crate holds an hour of other ungridded tracks: keep the job to techno/
    def scope(route):
        posted.append(route.request.post_data)
        route.continue_(post_data=json.dumps({"folder": "techno"}),
                        headers={**route.request.headers, "content-type": "application/json"})
    page.route("**/api/cabine/grid/all", scope)
    page.click("#cab-grid-all")
    expect(page.locator("#cab-job")).to_contain_text("grid everything: done", timeout=120_000)
    assert posted == ["{}"], posted
    assert sidecar.exists()
    g = json.loads(sidecar.read_text())
    assert g["bpm"] == pytest.approx(124.0, abs=0.5), g
    expect(row(page, file)).to_contain_text("124")
