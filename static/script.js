const GAME = window.location.pathname.substr(1);
let my_player_num = -1, hearts_broken = false;
let action_button, status_box, player, player_hand, current_hand, last_hand;
let socket;
let messages = [];

const STATE_WAITING = 0;
const STATE_TRADING = 1;
const STATE_PLAYING = 2;
let state = STATE_WAITING;
let joined = false;

const SUITS = 'cdsh';
const CARDS = '234567891JQKA';

// Messages
const GAME_URL = location.href.replace(/^https?:\/\//i, "");
const WELCOME_HEADER = "<h1><img src='/static/favicon.svg'> Welcome to Boompa's Hearts Table! <img src='/static/favicon.svg'></h1>";
const MSG_WELCOME = WELCOME_HEADER + `<center>Waiting for other players to join...<br>Tell others to go to <br><b>${GAME_URL}</b><br> to join this game!<br><br></center><div>Here so far are:</div><ul id='names'></ul>`;
const MSG_FULL_GAME = 'Game is full. <a href="/">Create a new game?</a>';
const MSG_INVALID_MOVE = '<center style="font-size:1.5em"><img style="width:10em" src="/static/images/evileye.png"><br>The Evil Eye is always watching!<br>Invalid Move!</center>';
const MSG_PROMPT_NAME = 'Player name:';
const MSG_PROMPT_PARTNER = "Who's the Granny to your Boompa?";
const MSG_PAUSED = WELCOME_HEADER + '<center>One moment, please, while we shuffle the cards.<br>Do you need more ice in that margarita?</center><ul id="names"></ul>';
const MSG_WON = '<center style="font-size:1.5em"><img src="/static/images/won.png"><br><b>Nice win, Old Bean!</b></center>';
const MSG_LOST = "<center style='font-size:1.5em'><img src='/static/images/lost.png'><br>\"Today is yesterday's tomorrow, but tomorrow is not yesterday's today...\"</center><p style='text-align:right'>~The Great Wise Ceiling</p><center style='font-size:1.5em'>Better luck tomorrow!</center>";
const MSG_WE_SHOT_THE_MOON = '<center style="font-size:1.5em"><img src="/static/images/shot_we.png" style="width:10em;"><br><b>\"Great gobs of fishworms!\"</b><br>You shot the moon!</center>';
const MSG_THEY_SHOT_THE_MOON = '<center style="font-size:1.5em"><img src="/static/images/shot_they.png" style="width:15em;"><br><br>\"Grunk!\"</center><div style="text-align:right">~Murgatroyd</div>';

/**
 * Returns a unique id that is 30+ digits and lowercase characters. First 8+ characters are
 * dependent on the current time but the remaining 22 are not.
 */
function unique_id() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 13) +
       Math.random().toString(36).substring(2, 13);
}

/**
 * Replaces the entire page with the given message in a box. The message may include HTML.
 */
function display_error_message(msg) {
    document.body.innerHTML = `<div id="overlay"><div id="message" class="error">${msg}</div></div>`;
}

/**
 * Displays a message as an overlay over the entire screen. The message may include HTML or be an
 * HTML node. If there is already a message than it is moved to the "stack" and this one is
 * displayed in its place.
 */
function display_overlay_message(msg, className) {
    let msg_box = document.getElementById('message');

    // Save previous message (if there)
    if (msg_box.childElementCount !== 0) {
        let elem;
        if (msg_box.childElementCount === 1) {
            elem = msg_box.removeChild(msg_box.firstChild);
        } else {
            elem = document.createElement('div');
            elem.append(...msg_box.childNodes);
        }
        messages.push([msg_box.className, elem]);
    }

    // Show new message
    if (typeof msg === 'string') {
        msg_box.innerHTML = msg;
    } else {
        //msg_box.replaceChildren(msg);
        msg_box.textContent = '';
        msg_box.appendChild(msg);
    }
    msg_box.className = className;

    // Display
    document.getElementById('overlay').style.display = 'block';
}

/**
 * Closes the overlay message.
 */
function dismiss_overlay_message(className, all) {
    if (typeof all === 'undefined') { all = false; }
    let msg_box = document.getElementById('message');

    console.log('trying to dismiss', className, messages.slice());
    
    if (msg_box.className === className) {
        // Dismiss current message, possibly show another message from the stack
        console.log('dismiss current message', className);
        msg_box.textContent = '';
        while (all && messages.length > 0 && messages[messages.length-1][0] === className) {
            console.log('removing from top of stack', className);
            messages.splice(messages.length-1, 1);
        }
        if (messages.length > 0) {
            console.log('moving to front', className);
            let [msg] = messages.splice(messages.length-1, 1);
            msg_box.className = msg[0];
            msg_box.appendChild(msg[1]);
        } else {
            console.log('closing overlay');
            document.getElementById('overlay').style.display = 'none';
        }
    } 
    
    if (msg_box.className !== className || all) {
        // Dismiss a hidden message in the stack
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i][0] === className) {
                messages.splice(i, 1);
                console.log('removing from middle of stack', className);
                if (!all) { break; }
            }
        }
    }
}

/**
 * Closes the overlay message, deleting the entire history.
 */
function dismiss_all_overlay_messages() {
    messages = [];
    document.getElementById('message').textContent = '';
    document.getElementById('overlay').style.display = 'none';
}

/**
 * Displays the initial waiting message to the user.
 */
function display_waiting_message() {
    display_overlay_message(MSG_WELCOME, 'waiting');
}

/**
 * Displays the help message to the user.
 */
function display_help_message() {
    if (document.getElementById('message').classList.contains('help')) { return; }
    alert_message(`<h1><img src='/static/favicon.svg'> Boompa Hearts <img src='/static/favicon.svg'></h1>
<p>The game is <b><i>Four Person Team Hearts</i></b>. Your partner is the player sitting across from
you. At the end of each hand, your score is combined with your partner's score. Unless stated
below, all <a href="https://bicyclecards.com/how-to-play/hearts/" target="_blank">standard
rules for Hearts apply</a>.</p>
<ul style="text-align:left">
<li>Shooting the Moon (you and your partner take all point cards, i.e. all Hearts and the Queen of Spades) gives the opponent team 36 points and permits you to gloat a bit</li>
<li>After cards are dealt each player chooses three cards to pass to another player depending on the hand: to the left, to the right, across (i.e. with your partner), hold (i.e. no passing), repeat</li>
<li>No "blood" (i.e. point cards) on the first trick unless your hand is exclusively point cards</li>
<li>You cannot lead with a point card until a one point card has been played unless your hand is exclusively point cards</li>
<li>The <span style="font-size:0.5em;vertical-align:super;">♥</span> symbol indicates if a team has taken any point card in the current hand</li>
<li>The last trick is always available to see along with the order in which it was played</li>
<li>The game ends when either team's score exceeds 100 points and the teams are not tied</li>
</ul>`, 'help');
}

/**
 * Makes an "Ok" button.
 */
function make_ok(onclick) {
    let button = document.createElement('input');
    button.type = 'submit';
    button.value = 'Ok';
    button.addEventListener('click', onclick);
    return button;
}

/**
 * Prompts the user with the given message, a drop-down box of the choices, and an "Ok" button.
 * When the user clicks the button, the callback function is called and is given the selected
 * index.
 */
function multiple_choice_prompt(prompt, choices, cb) {
    let form = document.createElement('form');
    form.appendChild(document.createElement('div')).innerHTML = prompt;
    let select = form.appendChild(document.createElement('select'));
    for (let choice of choices) {
        select.appendChild(document.createElement('option')).textContent = choice;
    }
    form.appendChild(make_ok((e) => {
        e.preventDefault();
        cb(select.selectedIndex);
        dismiss_overlay_message('mc_prompt');
        return false;
    }));
    display_overlay_message(form, 'mc_prompt');
    select.focus();
}

/**
 * Prompts the user with the given message, a text box, and an "Ok" button. When the user clicks
 * the button, the callback function is called and is given the entered text.
 */
function text_prompt(prompt, cb) {
    let form = document.createElement('form');
    form.innerHTML = prompt;
    let input = form.appendChild(document.createElement('input'));
    input.type = 'text';
    input.size = 25;
    input.maxLength = 32;
    form.appendChild(make_ok((e) => {
        e.preventDefault();
        cb(input.value);
        dismiss_overlay_message('text_prompt');
        return false;
    }));
    display_overlay_message(form, 'text_prompt');
    input.focus();
}

/**
 * Display a message the user and an "Ok" button.
 */
function alert_message(msg, className) {
    if (typeof className === 'undefined') { className = 'alert'; }
    let form = document.createElement('form');
    form.style.textAlign = 'center';
    form.appendChild(document.createElement('div')).innerHTML = msg;
    let ok = form.appendChild(make_ok((e) => {
        e.preventDefault();
        dismiss_overlay_message(className);
    }));
    display_overlay_message(form, className);
    ok.focus();
}

/**
 * Gets the position (one of bottom, left, top, or right) from the player number (0 through 3)
 * based on the global variable my_player_num.
 */
function player_position(player_num) {
    if (my_player_num === player_num) { return "bottom"; }
    let diff = (my_player_num - player_num) % 4;
    if (diff < 0) { diff += 4; }
    return ["bottom", "right", "top", "left"][diff];
}

/**
 * Gets the name of a card (like h10) from the HTML element for a card.
 */
function get_card_name(card) {
    for (let c of card.classList) {
        // regular expression: /^[cdsh]([23456789JQKA]|10)$/
        if (SUITS.includes(c[0]) && (c.length === 2 && '23456789JQKA'.includes(c[1]) || c.substring(1) === '10')) {
            return c;
        }
    }
    console.warn('not a known card', card);
}

/**
 * Gets a list of all of the card names under the given element.
 */
function get_card_names(collection) {
    return Array.from(collection).map(card => get_card_name(card));
}

/**
 * Gets a list of all of the card names for all of the currently selected cards.
 */
function get_selected_cards() {
    return get_card_names(player_hand.querySelectorAll('.selected'));
}

/**
 * Returns the card node from the collection that is the winning card in the hand.
 */
function get_winning_card(cards) {
    let names = get_card_names(cards);
    if (names.length === 0) { return null; }
    let suit = names[0][0];
    let found = 0;
    for (let i = 1; i < names.length; i++) {
       if (names[i][0] === suit && card_comparator(names[found], names[i]) < 0) {
           found = i;
       }
    }
    return cards[found];
}

/**
 * Card comparator function used to sort card names.
 */
function card_comparator(a, b) {
    let [suit_a, suit_b] = [a[0], b[0]];
    return suit_a === suit_b ? (CARDS.indexOf(a[1]) - CARDS.indexOf(b[1])) : (SUITS.indexOf(suit_a) - SUITS.indexOf(suit_b));
}

/**
 * Adds a card (from a string like h10), in sorted order, to the player's hand.
 */
function add_card(card) {
    let node = document.createElement('div');
    node.className = `card ${card}`;
    node.addEventListener('click', on_card_click);
    for (let c of player_hand.children) {
        if (card_comparator(card, get_card_name(c)) < 0) {
            // Found the first card that comes after this card
            return player_hand.insertBefore(node, c);
        }
    }
    // Card goes at end
    return player_hand.appendChild(node);
}

/**
 * Gets the names of the top and bottom players (with an & in between).
 */
function get_top_and_bottom_names() {
    let name_top = document.querySelector('#top .name').textContent;
    let name_bottom = document.querySelector('#bottom .name').textContent;
    return `${name_bottom} & ${name_top}`;
}

/**
 * Gets the names of the left and right players (with an & in between).
 */
function get_left_and_right_names() {
    let name_left = document.querySelector('#left .name').textContent;
    let name_right = document.querySelector('#right .name').textContent;
    return `${name_left} & ${name_right}`;
}

/**
 * Event for when clicking a card: toggles the selected class of the card and updates the
 * disabled/enabled state of the action button. This does only allow clicking cards when the state
 * is STATE_PLAYING and the card is not disabled.
 */
function on_card_click(e) {
    if (state === STATE_WAITING || this.classList.contains('disabled')) { return; }
    if (state === STATE_PLAYING) {
        for (let card of player_hand.querySelectorAll('.selected')) { card.classList.remove('selected'); }
    }
    this.classList.toggle('selected');
    let n = player_hand.querySelectorAll('.selected').length;
    action_button.disabled = (state !== STATE_TRADING || n !== 3) && (state !== STATE_PLAYING || n !== 1);
}

/**
 * Event handler for when the action button (either Trade or Play) is clicked.
 */
function on_action_click(e) {
    if (state === STATE_WAITING || this.disabled) { return; }

    // This is the callback for all actions:
    //   if invalid, report it
    //   otherwise, end the turn/trade
    function callback(msg) {
        console.log("action ack", msg);
        if (msg === 'invalid') {
            alert_message(MSG_INVALID_MOVE);
        } else {
            action_button.disabled = true;
            action_button.style.display = 'none';
            player.classList.remove('trading');
            player.classList.remove('current');
            state = STATE_WAITING;
        }
    }

    // Emit the appropriate event
    let cards = get_selected_cards();
    if (state === STATE_TRADING) {
        socket.emit('trade', cards, callback);
    } else if (state === STATE_PLAYING) {
        socket.emit('play_card', cards[0], callback);
    }
}

/**
 * Function called when the 'join' event completes and returns data.
 */
function join_ack(msg, ...args) {
    console.log("join ack", msg, args);
    if (msg === 'full') {
        display_error_message(MSG_FULL_GAME);
    } else {
        joined = true;
        if (msg === 'joined') {
            let names = args[0];
            let name_box = document.getElementById('names');
            if (name_box) {
                for (let name of names) {
                    name_box.appendChild(document.createElement('li')).textContent = name;
                }
            } else {
                for (let i = 0; i < names.length; i++) {
                    document.querySelector(`#${player_position(i)} .name`).textContent = names[i];
                }
            }
        } else if (msg === 'rejoined') {
            refresh_display(args);
        }
    }
}

/**
 * Refreshes the entire display for the state of the game given in args. See the 'refresh' event
 * for the format of the args list (which is 4 to 13 values long depending on the state).
 */
function refresh_display(args) {
    console.log('refreshing', args);
    let [refresh_state, names] = args.slice(0, 2);
    dismiss_all_overlay_messages();

    state = STATE_WAITING;
    document.body.className = refresh_state;
    if (refresh_state === 'waiting') {
        // TODO: waiting actually has 2 different states and this only represents the first one
        // That means with player #0 disconnects during second half the game is toast
        display_waiting_message();
        let name_box = document.getElementById('names');
        name_box.textContent = '';
        for (let name of names) {
            name_box.appendChild(document.createElement('li')).textContent = name;
        }
    
    } else {
        let [player_num, disconnected, hand_num, score_02, score_13, hand] = args.slice(2, 8);
        my_player_num = player_num;

        // Setup status info and names
        let tb_is_0 = player_num === 0 || player_num === 2;
        let [score_tb, score_lr] = tb_is_0 ? [score_02, score_13] : [score_13, score_02];
        status_box.querySelector('.hand').textContent = hand_num;
        status_box.querySelector('.score-tb').textContent = score_tb;
        status_box.querySelector('.score-lr').textContent = score_lr;
        for (let i = 0; i < names.length; i++) {
            document.querySelector(`#${player_position(i)} .name`).textContent = names[i];
        }
        status_box.querySelector('.names-tb').textContent = get_top_and_bottom_names();
        status_box.querySelector('.names-lr').textContent = get_left_and_right_names();
        for (let p of document.querySelectorAll('.player.disconnected')) { p.classList.remove('disconnected'); }
        for (let i = 0; i < disconnected.length; i++) {
            if (disconnected[i]) { document.getElementById(player_position(i)).classList.add('disconnected'); }
        }
    
        // Setup hand
        hand.sort(card_comparator);
        player_hand.textContent = '';
        for (let card of hand) {
            player_hand.appendChild(document.createElement('div')).className = `card ${card}`;
        }
        for (let pos of ['left', 'top', 'right']) {
            let ph = document.querySelector(`#${pos} .hand`);
            ph.textContent = '';
            while (ph.childElementCount < hand.length) {
                ph.appendChild(document.createElement('div')).className = 'card';
            }
        }
        for (let card of player_hand.children) { card.addEventListener('click', on_card_click); }

        // Clear/reset lots of things
        current_hand.textContent = '';
        last_hand.textContent = '';
        for (let player of document.querySelectorAll('.player.current')) { player.classList.remove('current'); }
        for (let player of document.querySelectorAll('.player.traded')) { player.classList.remove('traded'); }
        for (let card of player_hand.querySelectorAll('.disabled')) { card.classList.remove('disabled'); }
        for (let card of player_hand.querySelectorAll('.selected')) { card.classList.remove('selected'); }
        for (let card of player_hand.querySelectorAll('.hidden')) { card.classList.remove('hidden'); }
        player.classList.remove('trading');
        action_button.disabled = true;
        action_button.style.display = 'none';

        // Deal with specific game state
        if (refresh_state === 'trading') {
            let [pending_trade, have_traded] = args.slice(8, 10);
            status_box.querySelector('.tricks-tb').textContent = 0;
            status_box.querySelector('.tricks-lr').textContent = 0;
            for (let i = 0; i < 4; i++) {
                if (have_traded[i]) {
                    document.getElementById(player_position(i)).classList.add('traded');
                }
            }
            if (pending_trade === null) {
                let trade_dir = hand_num % 4;
                action_button.value = 'Trade '+('·︎↖︎↗︎↑︎'.substring(2*trade_dir, 2*trade_dir+2));
                action_button.style.display = 'block';
                state = STATE_TRADING;
            } else {
                for (let card of pending_trade) { player_hand.querySelector(`.${card}`).classList.add('hidden'); }
                player.classList.add('traded');
            }

        } else if (refresh_state === 'playing') {
            let [hb, nt0, nt1, trick_start_player, trick_cards, last_trick] = args.slice(8, 14);
            hearts_broken = hb;
            let [nt_tb, nt_lr] = tb_is_0 ? [nt0, nt1] : [nt1, nt0];
            let cur_player_num = (trick_start_player + trick_cards.length) % 4;
            let turns = player_num - trick_start_player;
            let played = 0 <= turns && turns < trick_cards.length || turns + 4 < trick_cards.length;

            status_box.querySelector('.tricks-tb').textContent = nt_tb;
            status_box.querySelector('.tricks-lr').textContent = nt_lr;
            document.getElementById(player_position(cur_player_num)).classList.add('current');

            for (let i = 0; i < trick_cards.length; i++) {
                let player = player_position((trick_start_player + i) % 4);
                if (!played) {
                    document.querySelector(`#${player} .hand .card`).remove();
                }
                current_hand.appendChild(document.createElement('div')).className = `${player} card ${trick_cards[i]}`;
            }

            last_hand.className = player_position(trick_start_player);
            if (last_trick.length > 0) {
                for (let card of last_trick) {
                    last_hand.appendChild(document.createElement('div')).className = `card ${card}`;
                }
                get_winning_card(last_hand.querySelectorAll('.card')).classList.add('selected');
            }

            if (played) {
                for (let i = trick_cards.length; i < 4; i++) {
                    let player = player_position((trick_start_player + i) % 4);
                    document.querySelector(`#${player} .hand`).appendChild(document.createElement('div')).className = 'card';
                }
            } else if (cur_player_num === player_num) {
                action_button.value = 'Play';
                action_button.style.display = 'block';
                state = STATE_PLAYING;
            }

        } else if (refresh_state === 'ended') {
            let msg = (score_tb < score_lr) ? MSG_WON : MSG_LOST;
            msg += `<br><center>Final score: ${score_tb} to ${score_lr}<br><a href="/">Create a new game?</a></center>`;
            display_overlay_message(msg, 'ended');
        }
    }
}

window.addEventListener('pageshow', function load() {
    // Preload common images
    new Image().src = 'static/images/deck.svg';
    for (let img of ['back', 'evileye']) { new Image().src = `static/images/${img}.png`; } // no: won, loss, shot_we, or shot_they

    // Setup global variables
    action_button = document.getElementById('action');
    status_box = document.getElementById('status');
    current_hand = document.getElementById('current-hand');
    last_hand = document.getElementById('last-hand');
    player = document.getElementById('bottom');
    player_hand = player.querySelector('.hand');
    action_button.addEventListener('click', on_action_click);
    document.getElementById('help').addEventListener('click', display_help_message);

    // Clicking the name allows the user to rename
    player.querySelector('.name').addEventListener('click', function() {
        text_prompt(MSG_PROMPT_NAME, function(name) {
            if (name !== null && name !== '' && name.length <= 64) {
                localStorage.setItem('name', name);
                socket.emit('rename', name);
            }
        });
    });

    // Get user's name
    get_player_name(localStorage.getItem('name'), setup);
});

/**
 * Gets the players name. For an invalid name, prompts again. Once it gets a valid name it saves
 * it to the local storage and calls the oncomplete callback function passing it the name.
 */
function get_player_name(name, oncomplete) {
    if (typeof name === "undefined" || name === null || name === '' || name.length > 64) {
        text_prompt(WELCOME_HEADER + MSG_PROMPT_NAME, function(n) { get_player_name(n, oncomplete); } );
    } else {
        localStorage.setItem('name', name);
        oncomplete(name);
    }
}

/**
 * Setup the entire game given the user's name. Most of the work here is registering all of the
 * socket events.
 */
function setup(name) {
    // Display starting up overlay
    setTimeout(display_waiting_message, 0);

    // Get unique ID
    let uid = localStorage.getItem('uid');
    if (uid === null) {
        uid = unique_id();
        localStorage.setItem('uid', uid);
    }

    // Setup socket
    socket = io(window.location.origin, {path: '/game-io/'});
    socket.on('connect', () => {
        console.log('connect', socket.id);
        if (joined) {
            // We were previously joined but got reconnected, need to send the join event again
            socket.emit('join', uid, GAME, name, join_ack);
        }
    });
    socket.on('disconnect', (reason) => {
        // See https://socket.io/docs/v3/client-api/index.html#Event-%E2%80%98disconnect%E2%80%99
        console.log('disconnect', reason);
        display_overlay_message(
            `<p>Disconnected from server: ${reason}.</p><p>Wait to be automatically reconnected to the server or you may try <a href="javascript:window.location.reload(true)">refreshing</a>.</p>`,
            'error'
        );
    });
    // socket.on('connect_error', (error) => {
    //     console.log('connect_error', reason);
    //     display_overlay_message(
    //         `<p>Connection error: ${error}.</p><p>You may try <a href="javascript:window.location.reload(true)">refreshing</a>.</p>`,
    //         'error'
    //      );
    // });

    socket.on('joined', (name) => {
        console.log('joined', name);
        let names_box = document.getElementById('names');
        if (names_box) { names_box.appendChild(document.createElement('li')).textContent = name; }
    });

    socket.on('renamed', (name, player_num) => {
        console.log('renamed', name, player_num);
        document.querySelector(`#${player_position(player_num)} .name`).textContent = name;
        status_box.querySelector('.names-tb').textContent = get_top_and_bottom_names();
        status_box.querySelector('.names-lr').textContent = get_left_and_right_names();

        // TODO
        let name_box = document.getElementById('names');
        if (name_box) { name_box.appendChild(document.createElement('li')).textContent = name; }
    });

    socket.on('rejoined', (player_num) => {
        console.log('rejoined', player_num);
        document.getElementById(player_position(player_num)).classList.remove('disconnected');
    });

    socket.on('disconnected', (player) => {
        console.log('disconnected', player);
        if (document.body.className === 'waiting') {
            // player is player name
            let name_box = document.getElementById('names');
            if (name_box) {
                let names = Array.from(name_box.querySelectorAll("li")).filter(li => li.textContent === player);
                if (names.length > 0) { names[0].remove(); }
            } else {
                // TODO: This happens during second half of player selection
            }
        } else {
            // player is player number (0-3)
            document.getElementById(player_position(player)).classList.add('disconnected');
        }
    });

    // Selects the partner of player #0
    socket.on('select_partner', (player_names) => {
        console.log('select_partner', player_names);
        multiple_choice_prompt(MSG_PROMPT_PARTNER, player_names, (choice) => {
            socket.emit('partner_selected', choice+1);
        });
    });

    // Keeps the other players busy while Player 0 picks their partner
    socket.on('pause', () => {
        console.log('pause');
        display_overlay_message(MSG_PAUSED, 'paused');
        // TODO
        // let name_box = document.getElementById('names');
        // for (let i = 0; i < names.length; i++) {
        //     name_box.appendChild(document.createElement('li')).textContent = name;
        // }
    });

    socket.on('start_game', (player_num, names) => {
        console.log('start_game');
        dismiss_overlay_message('paused', true);
        dismiss_overlay_message('waiting', true);
        my_player_num = player_num;
        for (let i = 0; i < names.length; i++) {
            document.querySelector(`#${player_position(i)} .name`).textContent = names[i];
        }
        status_box.querySelector('.names-tb').textContent = get_top_and_bottom_names();
        status_box.querySelector('.names-lr').textContent = get_left_and_right_names();
    });

    socket.on('start_hand', (cards, hand_num) => {
        console.log('start_hand', cards, hand_num);

        // Setup the card hands
        cards.sort(card_comparator);
        player_hand.textContent = ''
        for (let card of cards) {
            player_hand.appendChild(document.createElement('div')).className = `card ${card}`;
        }
        for (let pos of ['left', 'top', 'right']) {
            let hand = document.querySelector(`#${pos} .hand`);
            while (hand.childElementCount < 13) {
                hand.appendChild(document.createElement('div')).className = 'card';
            }
        }
        for (let card of player_hand.children) { card.addEventListener('click', on_card_click); }
    
        // Remove the old indicators
        last_hand.textContent = '';
        for (let player of document.querySelectorAll('.player.current')) { player.classList.remove('current'); }

        // Update indicators/buttons
        status_box.querySelector('.hand').textContent = hand_num;
        status_box.querySelector('.tricks-tb').textContent = 0;
        status_box.querySelector('.tricks-lr').textContent = 0;
        status_box.querySelector('.tricks-tb').classList.remove('has-point');
        status_box.querySelector('.tricks-lr').classList.remove('has-point');
        action_button.disabled = true;
        let trade_dir = hand_num % 4;
        if (trade_dir !== 0) {
            action_button.value = 'Trade '+('·︎↖︎↗︎↑︎'.substring(2*trade_dir, 2*trade_dir+2));
            action_button.style.display = 'block';
            player.classList.add('trading');
            document.body.className = 'trading';
            state = STATE_TRADING;
        }
    });

    socket.on('traded', (player_num) => {
        console.log('traded', player_num);
        document.getElementById(player_position(player_num)).classList.add('traded');
        document.getElementById(player_position(player_num)).classList.remove('disconnected');
    });

    socket.on('finish_trade', (given, received) => {
        console.log('finish_trade', given, received);
        action_button.disabled = true;
        action_button.style.display = 'none';
        player.classList.remove('trading');
        document.body.className = 'playing';
        state = STATE_WAITING;
        for (let player of document.querySelectorAll('.traded')) { player.classList.remove('traded'); }
        for (let card of player_hand.querySelectorAll('.selected')) { card.classList.remove('selected'); }
        for (let card of player_hand.querySelectorAll('.hidden')) { card.classList.remove('hidden'); }
        for (let card of given) { player_hand.querySelector(`.${card}`).remove(); }
        for (let card of received) { add_card(card).classList.add('selected'); }
    });

    socket.on('start_turn', (player_num) => {
        console.log('start_turn', player_num);
        for (let player of document.querySelectorAll('.player.current')) { player.classList.remove('current'); }
        document.getElementById(player_position(player_num)).classList.add('current');
        if (player_num === my_player_num) {
            action_button.value = 'Play';
            action_button.disabled = true;
            action_button.style.display = 'block';
            state = STATE_PLAYING;
        }
    });

    socket.on('card_played', (card, player_num) => {
        console.log('card_played', card, player_num);
        let player = player_position(player_num);
        let selector = `#${player} .hand .card`
        if (player_num === my_player_num) { selector += `.${card}` }
        document.querySelector(selector).remove();
        document.getElementById(player).classList.remove('disconnected');
        current_hand.appendChild(document.createElement('div')).className = `${player} card ${card}`;
        if (current_hand.childElementCount === 1) {
            // TODO: disable/reenable cards based on "breaking suit" (if this is added then add it in refresh as well)
        }
        if (card[0] === 'h' || card === 'sQ') {
            hearts_broken = true;
        }
    });

    socket.on('end_trick', (winner) => {
        console.log('end_trick', winner);
        let player = player_position(winner);

        // Move the cards into the last hand
        last_hand.className = player;
        last_hand.textContent = '';
        last_hand.append(...current_hand.childNodes);
        get_winning_card(last_hand.querySelectorAll('.card')).classList.add('selected');

        // Update the tricks box
        let tricks_box = status_box.querySelector(
            (player === "top" || player === "bottom") ? '.tricks-tb' : '.tricks-lr');
        tricks_box.textContent = parseInt(tricks_box.textContent, 10) + 1;
        for (let card of get_card_names(last_hand.childNodes)) {
           if (card[0] === 'h' || card === 'sQ') {
                tricks_box.classList.add('has-point');
                break;
            }
        }
    });


    socket.on('end_hand', (score_02, score_13) => {
        console.log('end_hand', score_02, score_13);
        let tb_is_0 = my_player_num === 0 || my_player_num === 2;
        let [score_tb, score_lr] = tb_is_0 ? [score_02, score_13] : [score_13, score_02];
		let old_tb_score = +status_box.querySelector('.score-tb').textContent;
		let old_lr_score = +status_box.querySelector('.score-lr').textContent;
        status_box.querySelector('.score-tb').textContent = score_tb;
        status_box.querySelector('.score-lr').textContent = score_lr;
        hearts_broken = false;
        if (score_tb-old_tb_score === 0) {
            alert_message(MSG_WE_SHOT_THE_MOON);
        } else if (score_lr-old_lr_score === 0) {
            alert_message(MSG_THEY_SHOT_THE_MOON);
        }
    });

    socket.on('end_game', (score_02, score_13) => {
        console.log('end_game', score_02, score_13);
        let tb_is_0 = my_player_num === 0 || my_player_num === 2;
        let [score_tb, score_lr] = tb_is_0 ? [score_02, score_13] : [score_13, score_02];
        let msg = (score_tb < score_lr) ? MSG_WON : MSG_LOST;
        msg += `<br><center>Final score: ${score_tb} to ${score_lr}<br><a href="/">Create a new game?</a></center>`;
        display_overlay_message(msg, 'ended');
        document.body.className = 'ended';
    });

    
    // Join the game!
    socket.emit('join', uid, GAME, name, join_ack);
}
