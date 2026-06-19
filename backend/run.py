"""Development entry: uvicorn with auto-reload."""

import argparse
try:
    import uvloop
    uvloop.install()
except ImportError:
    pass
import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="CloudMind-Zome backend dev server")
    parser.add_argument("--port", type=int, default=8848, help="Port to bind (default: 8848)")
    args = parser.parse_args()

    uvicorn.run("app.main:app", host="127.0.0.1", port=args.port, reload=True)


if __name__ == "__main__":
    main()
