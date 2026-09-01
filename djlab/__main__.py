"""CLI: python -m djlab <command>  (or the ./dj wrapper).

Commands:
    analyze [folder]        BPM/key/warp log for sources (default: sources/)
    beds [--nums 1,2] [--demo]   render naked techno frames
    render [--blend N | --all]   render blends (bed-only if sources missing)
    sources                 print the drop-zone shopping list
    stems FILE              run Demucs on one file
    ui [--port P]           start the web platform
"""

import argparse
from pathlib import Path

from . import analyze as an
from . import recipes as rc


def main() -> None:
    ap = argparse.ArgumentParser(prog="djlab")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_an = sub.add_parser("analyze")
    p_an.add_argument("folder", nargs="?", default=str(rc.SOURCES))

    p_beds = sub.add_parser("beds")
    p_beds.add_argument("--nums", default="1,2,3,4,5,6,7")
    p_beds.add_argument("--demo", action="store_true")

    p_r = sub.add_parser("render")
    p_r.add_argument("--blend", type=int)
    p_r.add_argument("--all", action="store_true")

    sub.add_parser("sources")
    sub.add_parser("pair")

    p_st = sub.add_parser("stems")
    p_st.add_argument("file")

    p_ui = sub.add_parser("ui")
    p_ui.add_argument("--port", type=int, default=8127)
    p_ui.add_argument("--host", default="0.0.0.0")

    args = ap.parse_args()
    if args.cmd == "analyze":
        results = an.analyze_folder(Path(args.folder),
                                    rc.ROOT / "analysis.json")
        an.print_log(results)
    elif args.cmd == "beds":
        nums = [int(n) for n in args.nums.split(",")]
        rc.render_beds(nums, demo=args.demo)
    elif args.cmd == "render":
        nums = [args.blend] if args.blend else list(rc.RECIPES)
        for n in nums:
            rc.render_blend(n)
    elif args.cmd == "sources":
        rc.print_sources()
    elif args.cmd == "pair":
        from . import engine
        engine.run(rc.ROOT)
    elif args.cmd == "stems":
        for name, p in rc.ensure_stems(Path(args.file)).items():
            print(f"  {name}: {p}")
    elif args.cmd == "ui":
        import uvicorn
        uvicorn.run("djlab.server:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
