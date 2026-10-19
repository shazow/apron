# Apron Frequently Asked Questions

## Who are you?

Hi I'm Andrey (@shazow), you may know me from such projects as [ssh.chat](https://ssh.chat), [urllib3](https://github.com/urllib3/urllib3), and [others](https://shazow.net).

## Why did you make the Apron Chat Protocol?

I wanted a protocol that optimized ease of implementation given some clear trust assumptions: We trust the Apron server. Perfect for self-hosting!

This allows getting rid of some of the most complex parts of chat protocols:
- No end-to-end encryption between users (use TLS to connect to the server, like `wss://`)
- No identity federation (each server is authoritative over the accounts on it)
- No message signing
- No cross-server sync, etc.

Apron aspires to be more like HTTP, which has similar tradeoffs. There will be many Apron clients who can connect to any Apron server. It should be easy to make a custom server with personalized behaviour.

## Is there encryption? Is it safe?

If you trust the server and use an encrypted connection like `wss://` then it's safe. There's no encryption between users, see the previous question for why.

## Why not XMPP/Matrix/IRCv3/etc?

Apron makes important tradeoffs on a different axis than other chat protocols, which allows for a simpler protocol. It's not intended for large public federated chat networks, but rather for small self-hosted group chats (for families, friends, teams, agents, etc).

## Why not Slack/Discord/Zulip/etc?

Apron drew a lot of inspiration from various group chat SaaS offerings, and Zulip of course (yay for being permissive open source)!

The main distinction is that Apron is designed for there to be a plurality of frontend clients, and even more server implementations. It should be super easy to put together a quick Apron server or client for a niche scenarios, like tiny embeddable help chat for your website, or a way to talk to your LLM at home.

Chats like Zulip and Discord are great but they're designed to be tightly coupled between the server and client (it's designed to work with one server implementation and client). Apron wants to be more like HTTP: Lots of servers, many of clients.

