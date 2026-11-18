def build():
    return 1

def option(x):
    return x

@option(build())
def decorated():
    from .core import Pool as cls
    return cls()

def other():
    from .core import Engine as cls
    return cls()
