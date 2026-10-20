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

Apron makes important tradeoffs on a different axis than other chat protocols, which allows for a simpler protocol. It's not intended for large public federated chat networks, but rather for small self-hosted group chats (for families, friends, teams, agents, commercial services, etc).

## Why not Slack/Discord/Zulip/etc?

Apron drew a lot of inspiration from various group chat SaaS offerings, and Zulip of course (yay for being permissive open source)!

The main distinction is that Apron is designed for there to be a plurality of frontend clients, and even more server implementations. It should be super easy to put together a quick Apron server or client for a niche scenarios, like tiny embeddable help chat for your website, or a way to talk to your LLM at home.

Chats like Zulip and Discord are great but they're designed to be tightly coupled between the server and client (it's designed to work with one server implementation and client). Apron wants to be more like HTTP: Lots of servers, many of clients.

## How was AI used to create Apron? Is it slop?

Apron is a culmination of something I've wanted to design and create for many years now, but I knew that normally it would take a small team many months to put it together. Part of this project is experimenting with a new kind of protocol-centric agentic engineering. I mainly used Anthropic's and OpenAI's latest models (Opus 5.5, Fable 5.1 and GPT 6.1 Sol) throughout the process:

The PROTOCOL.md was carefully researched and iterated based on a design I've been thinking about, but each major version change would spin out a number of fully autocoded implementations that exercise different conditions and priorities, which would then get reviewed for frictions and common failure modes. I used an eval-like loop to make sure the nuances in the PROTOCOL.md produced good server and client implementations _by default_ across as many scenarios as I could manage. 

Overall, AI was used quite heavily but not uniformly: PROTOCOL.md was scrutinized carefully line-by-line across almost 200 sessions, the user-facing copy (like this document) is meat-written, the reference implementations are a mix of being fully autocoded across many iterative prompt sessions and reviewed. I was able to get the bulk of the initial public release done over a few intense weeks of iteration.

## Is Apron a business?

No, it's a permissively licensed protocol (CC0) and reference implementations (MIT). You can make a business on it if you want! I have no plans for it right now, but I'd like to use it more and more in various projects over the coming years, so who knows. It's intended to be an evergreen public good that anyone can use when it makes sense.

