"use strict";

var Promise = require("bluebird");

var TelegramGhost = require("./TelegramGhost");

function Portal(main, opts) {
    this._main = main;

    this._matrix_room_id = opts.matrix_room_id;
    this._matrix_user_id = opts.matrix_user_id || opts.matrix_user.userId();
    this._matrix_user    = opts.matrix_user;
    this._peer           = opts.peer;
}

Portal.fromEntry = function(main, entry) {
    if (entry.type !== "portal") {
        throw new Error("Can only make Portal out of entry.type == 'portal'");
    }

    return new Portal(main, {
        matrix_room_id: entry.data.matrix_room_id,
        matrix_user_id: entry.data.matrix_user_id,
        peer:           TelegramGhost.Peer.fromSubentry(entry.data.peer),
    });
}

Portal.prototype.toEntry = function() {
    var key = this.getKey();

    return {
        type: "portal",
        id: key,
        data: {
            matrix_user_id: this._matrix_user_id,
            matrix_room_id: this._matrix_room_id,
            peer:           this._peer.toSubentry(),
        },
    };
};

Portal.prototype.getKey = function() {
    return [this._matrix_user_id, this._peer.getKey()].join(" ");
};

Portal.prototype.getMatrixRoomId = function() {
    return this._matrix_room_id;
};

Portal.prototype.getMatrixUser = function() {
    if (this._matrix_user) return Promise.resolve(this._matrix_user);
    return this._main.getOrCreateMatrixUser(this._matrix_user_id).then((user) => {
        this._matrix_user = user;
        return user;
    });
};

Portal.prototype.getTelegramGhost = function() {
    return this.getMatrixUser().then((user) => user.getTelegramGhost());
};

Portal.prototype.provisionMatrixRoom = function() {
    // Create the room.
    // Invite the MatrixUser to it

    if (this._matrix_room_id) return Promise.resolve();

    var bot = this._main.getBotIntent();

    var chat_info;
    return this.getTelegramGhost().then((ghost) => {
        return ghost.getChatInfo(this._peer);
    }).then((_info) => {
        chat_info = _info;

        return bot.createRoom({
            options: {
                // Don't give it an alias
                name: chat_info.title,
                visibility: "private",
            }
        });
    }).then((result) => {
        this._matrix_room_id = result.room_id;
        this._main._portalsByMatrixId[this._matrix_room_id] = this;

        // TODO: set room avatar image

        return this._main.putRoom(this);
    }).then(() => {
        return this._fixParticipants(chat_info.participants, true);
    }).then(() => {
        return bot.invite(this._matrix_room_id, this._matrix_user_id);
    });
};

Portal.prototype.fixMatrixRoom = function() {
    var bot = this._main.getBotIntent();
    var room_id = this._matrix_room_id;

    return this.getTelegramGhost().then((ghost) => {
        return ghost.getChatInfo(this._peer);
    }).then((info) => {
        return Promise.all([
            bot.setRoomName(room_id, info.title),
            this._fixParticipants(info.participants),
        ])
    });
};

function _maybe_invite(bot_intent, room_id, user_id, callback) {
    return callback().then(
        (result) => result,
        (err) => {
            if (!err.errcode ||
                err.errcode !== "M_FORBIDDEN") throw err;

            // Invite then retry one more time
            return bot_intent.invite(room_id, user_id).then(() => {
                return callback();
            });
        }
    );
}

Portal.prototype._fixParticipants = function(participants, invite_first) {
    var main = this._main;
    var room_id = this._matrix_room_id;

    var bot_intent = main.getBotIntent();

    return Promise.all(
        participants.map((p) => {
            var displayname = [p.first_name, p.last_name].filter((s) => !!s)
                .join(" ");

            var intent = main.getMatrixGhostFor({user: p});
            var user_id = intent.client.credentials.userId;
            console.log("My user ID is", user_id);

            // TODO: Create user avatar images
            //   Work out how to cache the media

            return _maybe_invite(bot_intent, room_id, user_id, () => {
                return intent.sendStateEvent(room_id, "m.room.member", user_id,
                    {
                        membership: "join",
                        displayname: displayname,
                    }
                );
            });
        })
    );
};

Portal.prototype.onMatrixEvent = function(ev) {
    switch(ev.type) {
        case "m.room.message":
            return this.getMatrixUser().then((user) => {
                return user.getTelegramGhost();
            }).then((ghost) => {
                // TODO: this only copes with msgtype=="m.text"
                return ghost.sendMessage(this._peer, ev.content.body);
            });
            break;

        default:
            console.log("Incoming event", ev, "to", this);
            break;
    }
};

Portal.prototype.onTelegramUpdate = function(update, hints) {
    var user_intent;

    var from_id = hints.from_id;

    var type = update.getTypeName().replace(/^api\.type\./, "");
    switch(type) {
        case "UpdateNewChannelMessage":
            update = update.message;
            /* fallthrough */
        case "UpdateShortChatMessage":
            console.log(` | user ${from_id} sent message`);
            user_intent = this._main.getMatrixGhostFor({user_id: from_id});

            return user_intent.sendText(this._matrix_room_id, update.message);

        case "UpdateChatUserTyping":
            console.log(` | user ${update.user_id} is typing`);
            // ignore for now
            return Promise.resolve();

        case "UpdateReadChannelInbox":
            // another session read up to here
            return Promise.resolve();

        default:
            console.log(`Unrecognised UPDATE ${type}:`, update);
            break;
    }
};

module.exports = Portal;
