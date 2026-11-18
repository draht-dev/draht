import typing as t

LIMIT = 3

if t.TYPE_CHECKING:
    class Hint:
        pass

class Base:
    def start(self):
        return 1

class Mixin(t.Generic[t.Any]):
    pass

class Engine(Base, Mixin):
    def __init__(self):
        self.pool = Pool()

    def run(self):
        self.start()
        self.pool.acquire()

class Pool:
    def acquire(self):
        return 2
