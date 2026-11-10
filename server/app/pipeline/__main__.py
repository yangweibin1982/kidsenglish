"""python -m app.pipeline 入口（委托 cli.main）。"""
from app.pipeline.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
