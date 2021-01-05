Online Hearts Game
==================

The server is written in Python and the front-end is written in JavaScript. They communicate using the socket.io library ([JS client](https://github.com/socketio/socket.io-client) and [Python server](https://python-socketio.readthedocs.io/en/latest/)).

To get the server running, first you need to install the Tornado and socket.io libraries:

'''shell
pip3 install python-socketio tornado
'''

Then the server can be run as follows:

'''shell
python3 server.py
'''

which will run on port 8000 by default. Using the argument --port this can be changed. The listening address is by default everything, but this can be changed as well with --address.

The / address of the server simply generates a new game name using 3 random words and redirects to it. Once in a game, one of the players can share their game link with other people they want to play with.
