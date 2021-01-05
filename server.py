import os.path
import random

import asyncio

import socketio

from tornado.ioloop import IOLoop
import tornado.web
from tornado.options import define, options

# A complete deck of cards
DECK = (
    'c2', 'd2', 'h2', 's2', 'c3', 'd3', 'h3', 's3', 'c4', 'd4', 'h4', 's4', 'c5', 'd5', 'h5', 's5',
    'c6', 'd6', 'h6', 's6', 'c7', 'd7', 'h7', 's7', 'c8', 'd8', 'h8', 's8', 'c9', 'd9', 'h9', 's9', 'c10', 'd10', 'h10', 's10',
    'cJ', 'dJ', 'hJ', 'sJ', 'cQ', 'dQ', 'hQ', 'sQ', 'cK', 'dK', 'hK', 'sK', 'cA', 'dA', 'hA', 'sA',
)

# How cards are traded during different hands
#   The outer list is indexed by the hand number mod 4
#   The inner list is indexed by player number (0-4)
#   The value given is a player number to trade with
TRADING = [
    [0,1,2,3], # keep
    [3,0,1,2], # left
    [1,2,3,0], # right
    [2,3,0,1], # across
]

# Total score to win
SCORE_TO_WIN = 100


def card_sort_key(card):
    """Key function for sorting cards. Usable as key argument of list.sort(), max(), and min()."""
    num = card[1:]
    num = int(num) if num.isdigit() else {'J':11, 'Q':12, 'K':13, 'A':14}[num]
    return card[0], num

def is_point_card(card):
    """Returns True if the card is a point card"""
    return card[0] == 'h' or card == 'sQ'

class Player:
    """A single player in the game."""
    def __init__(self, num, uid, sid, name):
        self.num = num # player number (0-4)
        self.uid = uid # user identifier for this player
        self.sid = sid # socket.io identifier for this player
        self.disconnected = False # True if the player has disconnected
        self.name = name # name displayed for this player
        self.hand = [] # current hand of cards for this player (each a string like 'c5')
        self.pending_trade = None # list of cards being traded (each a string like 'c5')
        self.turn = False # True if this player is currently playing a card

    def emit(self, event, *args):
        """
        Sends a message to this player (and only this player). The message will be sent AFTER the
        current message is done being handled and the order of messages will be kept.
        """
        IOLoop.current().add_callback(sio.emit, event, args, to=self.sid)

    def has_suit(self, suit):
        """Returns true if any card in the hand has the given suit."""
        return any(c[0] == suit for c in self.hand)

    def has_nonpoint_card(self):
        """Returns true if any card in the hand is not a point card."""
        return any(not is_point_card(c) for c in self.hand)

    def cannot_play_point_card(self, card):
        """Returns true if the player has any non-point card and the card given is a point card."""
        return is_point_card(card) and self.has_nonpoint_card()


class Game:
    """A single game being player by 4 people."""
    def __init__(self, name):
        self.name = name # unique name for this game
        self.state = 'waiting' # state of the game, one of waiting, trading, playing, or ended
        self.players = [] # list of players in this game (each Player object)
        self.sid2player = {} # dictionary of socket.io identifiers to their Player object
        self.hand_num = 0 # number of hands played or currently being played in this game
        self.score0 = 0 # number of points 0/2 team has overall
        self.score1 = 0 # number of points 1/3 team has overall

        # current hand info
        self.hearts_broken = False # if hearts have been broken in this hand so far
        self.num_tricks0 = -1 # number of tricks taken by the 0/2 team this hand
        self.num_tricks1 = -1 # number of tricks taken by the 1/3 team this hand
        self.hand_score0 = -1 # number of points taken by the 0/2 team this hand
        self.hand_score1 = -1 # number of points taken by the 1/3 team this hand

        # current trick info
        self.trick_start_player = None # player who started the current trick (Player object)
        self.trick_cards = [] # cards played in this trick so far (each a string like 'c5')
        self.last_trick = [] # last trick of cards played

    def emit(self, event, *args):
        """
        Sends a message to all players in this game. The message will be sent AFTER the
        current message is done being handled and the order of messages will be kept.
        """
        IOLoop.current().add_callback(sio.emit, event, args, room=self.name)

    def player(self, sid):
        """Gets a player object from the socket.io identifier for the user."""
        return self.sid2player[sid]

    def join(self, uid, sid, name):
        """
        Called when a player initially joins the game. If this is the fourth player to join, then
        this emits special messages to get the game going.

        Arguments:
          sid  - socket.io identifier for the user joining the game
          uid  - user identifier for this user
          name - the player's display name
        
        Returns:
          'full' if the user cannot join the game. Tuple of 'joined' and list of other player names
          when successfully joining.

        Messages emitted:
          On success, this emits the 'joined' message with the new player name. If this causes the
          game to start, this will emit 'select_partner' to player number 0 (with a list of all
          player names except player number 0) and 'pause' to all other players.
        """
        num_players = len(self.players)
        if sid in self.sid2player or (num_players >= 4 or self.state != 'waiting'): return 'full'
        others = [p.name for p in self.players]
        player = self.sid2player[sid] = Player(num_players, uid, sid, name)
        self.players.append(player)
        sio.enter_room(sid, self.name)
        self.emit('joined', name)
        if player.num == 3:
            options = self.players[1:]
            self.players[0].emit('select_partner', [p.name for p in options])
            for p in options: p.emit('pause')
        return 'joined', others

    def rename(self, sid, name):
        """
        Called to rename a player.

        Arguments:
          sid  - socket.io identifier for the user being renamed
          name - the player's display name
        
        Messages emitted:
          If the name changed this emits 'renamed' with the name and player's number (0-4).
        """
        p = self.player(sid)
        if p.name != name:
            p.name = name
            self.emit('renamed', name, p.num)

    def rejoin(self, old_sid, new_sid):
        """
        Called to have a player rejoin the game (after disconnect/refresh).

        Arguments:
          old_sid - old socket.io identifier for the user
          new_sid - new socket.io identifier for the user

        Returns:
          The complete state of the game. See refresh() but this return value has the additional
          string 'rejoined' at the beginning.
        
        Messages emitted:
          This emits the 'rejoined' message with the player's number (0-4).
        """
        p = self.player(old_sid)
        del self.sid2player[old_sid]
        self.sid2player[new_sid] = p
        p.sid = new_sid
        p.disconnected = False # p.disconnected should be False before this
        sio.leave_room(old_sid, self.name)
        sio.enter_room(new_sid, self.name)
        self.emit('rejoined', p.num)
        return ('rejoined',) + self.refresh(new_sid)

    def refresh(self, sid):
        """
        Called to have a player refresh their data about the game.

        Arguments:
          sid - socket.io identifier for the user

        Returns:
          Depending on the current state, this returns one of the following sets of data:
            'waiting', player names (length 1-4)
            'trading', ", ", player number (0-4), list of disconnected players, hand # (1+), 0/2
                team score, 1/3 team score, list of cards in hand, list of pending trade cards (or
                None), list of players who have traded
            'playing', ", ", ", ", ", ", if hearts broken, 0/2 team # tricks, 1/3 team # tricks,
                trick start player num, list of cards in trick so far, list of cards in last trick
            'ended', ", ", ", score for 0/2, score for 1/3
        """
        names = [p.name for p in self.players]
        p = self.player(sid)
        data = (self.state, names)
        if self.state != 'waiting':
            data += (p.num, [p.disconnected for p in self.players], self.hand_num,
                     self.score0, self.score1, p.hand)
        if self.state == 'trading':
            data += (p.pending_trade, [p.pending_trade is not None for p in self.players])
        elif self.state == 'playing':
            data += (self.hearts_broken, self.num_tricks0, self.num_tricks1,
                     self.trick_start_player.num, self.trick_cards, self.last_trick)
        elif self.state == 'ended':
            data += (self.score0, self.score1)
        return data

    def disconnected(self, sid):
        """
        Called when a player disconnects form the game.

        Arguments:
          sid - socket.io identifier for the user

        Returns:
          True if there are no longer any connected players in this game, False otherwise.

        Messages emitted:
          Emits the 'disconnected' message with the player number (0-4) to the remaining players.
        """
        p = self.player(sid)
        sio.leave_room(sid, self.name)
        if self.state == 'waiting':
            self.emit('disconnected', p.name)
            self.players.remove(p)
            del self.sid2player[sid]
            return len(self.players) == 0
        else:
            self.emit('disconnected', p.num)
            p.disconnected = True
            return all(p.disconnected for p in self.players)

    def partner_selected(self, partner_num):
        other_partner_nums = sorted({1,2,3}-{partner_num})
        new_player_order = [0, other_partner_nums[0], partner_num, other_partner_nums[1]]
        self.players = [self.players[i] for i in new_player_order]
        names = [p.name for p in self.players]
        for i, p in enumerate(self.players):
            p.num = i
            p.emit('start_game', i, names)
        self.start_hand()

    def start_hand(self):
        """
        Starts a hand. This shuffles the deck, deals 13 cards to each player, and then either
        leads into trading or playing the first time (if the hand number is a multiple of 4).

        The game's state after this method is called is either 'trading' or 'playing' depending on
        the hand number.

        Messages emitted:
          Emits a unique 'start_hand' message to each player that contains the a list of the cards
          (as strings like 'c5') dealt to that player and the number of the hand (with the first
          hand being #1).

          If the hand number is a multiple of 4 then there is no trading and this emits the
          'finish_trading' message with two empty lists (see trade() for more details). This also
          calls start_hand_after_trade() in this case which emits more messages.
        """
        deck = random.sample(DECK, k=52)
        self.hand_num += 1
        self.hearts_broken = False
        self.num_tricks0 = self.num_tricks1 = 0
        self.hand_score0 = self.hand_score1 = 0
        self.trick_cards = []
        self.last_trick = []
        for i, p in enumerate(self.players):
            p.hand = deck[i*13:(i+1)*13]
            p.emit('start_hand', p.hand, self.hand_num)
        if self.hand_num % 4 == 0:
            # every fourth hand there is no trading
            self.emit('finish_trade', [], [])
            self.start_hand_after_trade()
        else:
            self.state = 'trading'
    
    def trade(self, sid, cards):
        """
        Called to indicate that a player has decided to trade the given list of cards.

        Arguments:
          sid   - socket.io identifier for the user trading the cards
          cards - the list of cards being traded by the player (each card is a string like 'c5')

        Returns:
          'invalid' if the trade is invalid and 'pending' if the trade will be success once all
          players have submitted their trades.

        Messages emitted:
          On a non-invalid (pending) trade this emits the 'traded' message with the player number
          (0-4) to all players in the game.

          If this is the fourth and final trade for the hand then this emits a unique
          'finish_trade' message to each player with a list of cards that they gave and a list of
          cards they received (each card is a string like 'c5'). This also calls
          start_hand_after_trade() in this case which emits more messages.
        """
        p = self.player(sid)
        if (self.state != 'trading' or p.pending_trade is not None or
            len(cards) != 3 or any(card not in p.hand for card in cards)): return 'invalid'
        p.pending_trade = cards
        self.emit('traded', p.num)
        if all(p.pending_trade is not None for p in self.players):
            # done trading - actually execute them
            trading = [self.players[i].pending_trade for i in TRADING[self.hand_num % 4]]
            for p, trade in zip(self.players, trading):
                p.emit('finish_trade', p.pending_trade, trade)
                for card in p.pending_trade: p.hand.remove(card)
                p.hand.extend(trade)
                p.pending_trade = None
            self.start_hand_after_trade()
        return 'pending'

    def start_hand_after_trade(self):
        """
        Starts a hand after the trading has been completed for the hand. This calls start_trick()
        with the player who has the 2 of clubs.

        The game's state after this method is called is always 'playing'.

        Messages emitted:
          Emits no messages on its own, but calls start_trick() which indirectly does as well.
        """
        p = next(p for p in self.players if 'c2' in p.hand)
        self.start_trick(p)
        self.state = 'playing'

    def start_trick(self, p):
        """
        Starts a trick with the given player as the player who will play the first card.

        Arguments:
          p - Player object for player who is playing the first card of the trick

        Messages emitted:
          Emits no messages on its own, but calls start_turn() which does.
        """
        self.trick_start_player = p
        self.trick_cards = []
        self.start_turn(p)

    def start_turn(self, p):
        """
        Starts a player's turn during a trick.

        Arguments:
          p - Player object for player whose turn it is

        Messages emitted:
          Emits the 'start_turn' message with the player's number (0-4) whose turn it is to
          everyone in the game.
        """
        p.turn = True
        self.emit('start_turn', p.num)

    def play_card(self, sid, card):
        """
        Called when a player plays a card. Checks the card for validity and then moves the game
        along by calling either start_turn() or end_trick().

        Arguments:
          sid  - socket.io identifier for the user playing the card
          card - the card to play as a string like 'c5'

        Returns:
          'invalid' if the card is invali and 'played' if the card can be played

        Messages emitted:
          If the played card is valid this emits the 'card_played' message with the card played
          (as a string like 'c5') and the player's number (0-4) who played the card.

          This also indirectly causes messsages to be emitted through the start_turn() or
          end_trick() calls.
        """
        p = self.player(sid)
        if self.state != 'playing' or not p.turn or card not in p.hand: return 'invalid'
        first_trick = len(p.hand) == 13
        if not self.trick_cards:
            # First card:
            #  * first trick must be 'c2' 
            #  * cannot start with a point card if hearts not broken and not forced
            if first_trick and card != 'c2' or not self.hearts_broken and p.cannot_play_point_card(card):
                return 'invalid'
        else:
            # Other cards:
            #  * must follow suit if possible
            #  * cannot play a point card on first trick if possible
            led = self.trick_cards[0][0]
            if card[0] != led and p.has_suit(led) or first_trick and p.cannot_play_point_card(card):
                return 'invalid'

        p.turn = False
        p.hand.remove(card)
        self.trick_cards.append(card)
        if is_point_card(card): self.hearts_broken = True
        self.emit('card_played', card, p.num)

        if len(self.trick_cards) == 4:
            self.end_trick()
        else:
            self.start_turn(self.players[(p.num + 1) % 4])
        return 'played'

    def end_trick(self):
        """
        Ends a trick and adds the appropriate amount of points to one of the teams. This ends up
        calling either end_hand() or start_trick() based on where in the hand it is.

        Messages emitted:
          Emits the 'end_trick' message (after a short delay) with the player number (0-4) for the
          player who took the trick.

          This also indirectly causes messsages to be emitted through the start_trick() or
          end_hand() calls (both of which are only called after a delay).
        """
        led = self.trick_cards[0][0]
        matching = [c for c in self.trick_cards if led == c[0]]
        self.last_trick = self.trick_cards[:]
        high_card = max(matching, key=card_sort_key)
        index = self.trick_cards.index(high_card)
        p = self.players[(index + self.trick_start_player.num) % 4]
        points = (sum(1 for c in self.trick_cards if c[0] == 'h') +
                  (13 if 'sQ' in self.trick_cards else 0))
        if p.num in (0, 2):
            self.num_tricks0 += 1
            self.hand_score0 += points
        else:
            self.num_tricks1 += 1
            self.hand_score1 += points
        IOLoop.current().call_later(2, self._end_trick_delayed, p)
    
    def _end_trick_delayed(self, p):
        """
        The last portion of end_trick() that is delayed a few seconds before running.
        """
        self.emit('end_trick', p.num)
        if not p.hand:
            self.end_hand()
        else:
            self.start_trick(p)

    def end_hand(self):
        """
        Ends a hand, tallies up the scores, and starts a new hand (if the game is still going)
        or ends the game.

        Messages emitted:
          Emits the 'end_hand' message (after a delay) with the total scores for the 0/2 and 1/3
          teams.

          This also indirectly causes messsages to be emitted through the start_hand() or
          end_game() calls (both of which are only called after a delay).
        """
        score0, score1 = self.hand_score0, self.hand_score1
        if score0 == 26:
            score0, score1 = 0, 36
        elif score1 == 26:
            score0, score1 = 36, 0
        self.score0 += score0
        self.score1 += score1
        IOLoop.current().call_later(2, self._end_hand_delayed)
    
    def _end_hand_delayed(self):
        """
        The last portion of end_hand() that is delayed a few seconds before running.
        """
        self.emit('end_hand', self.score0, self.score1)
        if (self.score0 > SCORE_TO_WIN or self.score1 > SCORE_TO_WIN) and self.score0 != self.score1:
            self.end_game()
        else:
            self.start_hand()

    def end_game(self):
        """
        Ends a game. Sets the state to "ended" and sends out the final messages.

        Messages emitted:
          Emits the 'end_game' message with the total scores for the 0/2 and 1/3 teams.
        """
        self.state = 'ended'
        self.emit('end_game', self.score0, self.score1)


##### Tornado Server #####

# List of words to create games with
WORDS = [word.strip() for word in open('words.txt').readlines()]

define("address", default='', help="listen on the given address")
define("port", default=8000, help="run on the given port", type=int)

class RedirectToGameHandler(tornado.web.RequestHandler):
    """Redirects to a random game (three random words)"""
    async def get(self):
        name = '-'.join(random.sample(WORDS, k=3))
        self.redirect(f'/{name}')

class PlayGameHandler(tornado.web.RequestHandler):
    """Renders the game.html file for games"""
    async def get(self, *name_parts):
        self.render("game.html")

def make_app():
    return tornado.web.Application([
            (r"/", RedirectToGameHandler),
            (r"/(\w+)-(\w+)-(\w+)", PlayGameHandler),
            (r"/game-io/", socketio.get_tornado_handler(sio)),
        ],
        static_path=os.path.join(os.path.dirname(__file__), "static"),
        cookie_secret="boombas-cookies-123456")


##### socket.io #####

# Dictionary of all of the games (key is game name)
games = {}

# socket.io global server variable
sio = socketio.AsyncServer(
    async_mode='tornado',
    cors_allowed_origins=['https://boompahearts.coderforlife.com', 'http://localhost:8000'])

@sio.event
async def connect(sid, environ):
    pass

@sio.event
async def disconnect(sid):
    """Upon disconnection tell the game the sid disconnected"""
    session = await sio.get_session(sid)
    if 'game' in session:
        game = session['game']
        if game.disconnected(sid):
            del games[game.name]
            await sio.close_room(game.name)


# socket.io events mainly just call the game methods with the same names.
@sio.event
async def join(sid, uid, game_name, player_name):
    """
    Joins a game that either already has been created and needs to be created.
    This also saves the game in the session.

    NOTE: The uid is the user ID, not the session ID which resets every refresh. This ID
    is generated in JS and manually sent with the message. JS should persist this value.
    """
    if game_name not in games:
        games[game_name] = Game(game_name)
    game = games[game_name]

    p = next((p for p in game.players if p.uid == uid), None)
    if p is None:
        retval = game.join(uid, sid, player_name)
    else:
        if not p.disconnected: return 'full'
        retval = game.rejoin(p.sid, sid)
    if retval != 'full':
        session = await sio.get_session(sid)
        session['game'] = game
        await sio.save_session(sid, session)
    return retval

@sio.event
async def rename(sid, name):
    """Causes a player to be renamed."""
    session = await sio.get_session(sid)
    return session['game'].rename(sid, name)

@sio.event
async def partner_selected(sid, partner_num):
    """Player 0 is selecting their partner (a number 1-3)."""
    session = await sio.get_session(sid)
    return session['game'].partner_selected(partner_num)

@sio.event
async def refresh(sid):
    """Returns the complete data for the user to refresh the state of the game."""
    session = await sio.get_session(sid)
    return session['game'].refresh(sid)

@sio.event
async def trade(sid, cards):
    """Marks cards for trading for the current player."""
    session = await sio.get_session(sid)
    return session['game'].trade(sid, cards)

@sio.event
async def play_card(sid, card):
    """Has the player play a card."""
    session = await sio.get_session(sid)
    return session['game'].play_card(sid, card)

##### Main: start the server #####
if __name__ == "__main__":
    app = make_app()
    app.listen(options.port, address=options.address)
    IOLoop.current().start()
