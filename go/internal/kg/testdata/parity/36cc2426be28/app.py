from pkg import Engine, tools
import click

def main(engine: Engine, hook):
    engine.run()
    tools.build()
    hook()
    click.option()
    return Engine()
