from .util import normalize

class Alpha:
    def save(self):
        pass

class Beta:
    def run(self):
        q = """
SELECT * FROM t
"""
        self.save()
        return normalize(q)

    def after_sql(self):
        return 1

def main():
    return Beta().run()

if __name__ == "__main__":
    main()