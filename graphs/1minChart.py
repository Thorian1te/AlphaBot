import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
import json

def get_updated_data():
    with open('./priceData/1mBTCDATA.json', 'r') as file:
        data = json.load(file)
    return data

data = np.array(get_updated_data())
x = np.arange(len(data))

fig, ax = plt.subplots()
line, = ax.plot([], [], marker='o', linestyle='-', label='1 minute chart')

plt.xlabel('Price')
plt.ylabel('Time')
plt.title('Array of Data Plot')
plt.legend()

ax.set_ylim(data.min() - 10, data.max() + 10)

def init_plot():
    line.set_data(x, data)
    return line,
def update_plot(frame):
    global x, data

    new_data = get_updated_data()

    if len(new_data) != len(data):
        x = np.arange(len(new_data))
        data = np.array(new_data)
        line.set_xdata(x)
        ax.set_xlim(0, len(new_data))
    else:
        data[:] = new_data

    line.set_ydata(data)
    ax.set_ylim(data.min() - 10, data.max() + 10)

    return line,

ani = FuncAnimation(fig, update_plot, frames=None, init_func=init_plot, interval=6000, blit=True, save_count=100)

plt.show()