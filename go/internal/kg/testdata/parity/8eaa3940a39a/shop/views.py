from .models import Order

class View:
    def get(self):
        return Order()
