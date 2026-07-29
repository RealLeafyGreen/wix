// Small shared state object so app.js, chat.js, and call.js
// don't have to pass everything through events.
export const state = {
  user: null,          // firebase auth user
  profile: null,        // { uid, displayName, email }
  activeChatId: null,
  activePeer: null,     // { uid, displayName, email }
  unsubMessages: null,  // firestore listener teardown for current chat
  unsubPeerDoc: null,    // firestore listener teardown for the open peer's live profile (badge/status)
  unsubChatDoc: null,     // firestore listener teardown for the open chat doc itself (typing indicator)
  schoolMode: false,     // when true: incoming calls stay silent, notification only
  userCache: {},          // live uid -> {displayName, email, ...} — keeps names fresh everywhere, even in old chats
};
