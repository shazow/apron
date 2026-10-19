# Apron Frequently Asked Questions

## Who are you?

Hi I'm Andrey (@shazow), you may know me from such projects as [ssh.chat](https://ssh.chat), [urllib3](https://github.com/urllib3/urllib3), and [others](https://shazow.net).

## Why did you make the Apron Chat Protocol?

I wanted a protocol that optimized ease of implementation given some clear trust assumptions: We trust the Apron server. Perfect for self-hosting!

This allows getting rid of some of the most complex parts of chat protocols: Remove end-to-end encryption, remove identity federation, remove message signing, remove cross-server sync, etc.

Apron aspires to be more like HTTP: There will be many Apron clients who can connect to any Apron server. It should be easy to make a custom server with personalized behaviour.

