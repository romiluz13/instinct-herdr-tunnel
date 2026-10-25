# Herdr portal

A gateway that lets someone other than the person at the keyboard see and steer the coding agents running in Herdr, with the owner deciding what that someone may do.

## People

**Owner**:
The person who runs Herdr and the portal on their machine and decides what the portal may do.
_Avoid_: User, admin, operator

**Caller**:
Anything that holds the token and sends requests: a browser page, a script or an AI client.
_Avoid_: Client, token holder, remote user

## What the portal watches

**Session**:
One running Herdr server with its own workspaces. Most owners have one, named `default`.
_Avoid_: Instance, server

**Pane**:
One terminal area inside a session, addressed as `w1:p2`.
_Avoid_: Window, split, terminal

**Terminal**:
The program attachment a pane currently holds. A pane that is reused gets a new terminal, and a caller who names the old one is refused.
_Avoid_: Tty, shell

**Agent**:
A coding agent that Herdr recognizes in a pane, with a status of idle, working, blocked, done or unknown.
_Avoid_: Bot, assistant

**Dialog**:
A question an agent has put on screen and is waiting on, such as a permission prompt. Answering it is the owner's decision.
_Avoid_: Prompt (a prompt is text a caller sends to an agent), popup

## What a caller can look at

**Visible screen**:
The rows a pane shows right now. It is all a caller sees by default, and it is small.
_Avoid_: Viewport, snapshot

**History read**:
A read that returns more than the visible screen: the whole chat of an agent, or a plain pane's scrollback.
_Avoid_: Full read, transcript

**History mode**:
How complete a history read is: agent scrollback, host scrollback, or screen only.
_Avoid_: History type

**Host scrollback**:
Lines that Herdr itself keeps above a pane's screen and can scroll back to.
_Avoid_: Buffer

## What a caller can do

**Action**:
One named, parameter-checked operation the portal offers. Nothing outside the list can be asked for.
_Avoid_: Endpoint, command, method

**Write**:
An action that changes something: it types, starts, scrolls or clicks. Every write is recorded in the ledger and the audit log.
_Avoid_: Mutation, command

**Scroll**:
Moving a pane's view: through host scrollback where Herdr has it, otherwise as wheel events to the program in the pane.
_Avoid_: Page, pan

**Click**:
One mouse press and release on one cell, sent only if the text the caller expects is still under that cell.
_Avoid_: Tap, touch

**Controller**:
A short-lived Herdr attachment the portal opens for one click, or one scroll of a pane without Herdr scrollback, and closes straight after.
_Avoid_: Session, connection

**Switch**:
An environment variable with which the owner turns on a capability that is off by default: history, control, agent click or pane tags.
_Avoid_: Flag, feature toggle, setting

## What the owner sees in Herdr

**Pane tag**:
A short display-only label the portal puts on a pane it sent, or may have sent, input to, such as `prompt sent 14:07`, for Herdr's sidebar. It holds a verb, an outcome and a time, never input text, and expires after 15 minutes.
_Avoid_: Badge, status

**Plugin**:
The small Herdr plugin in `plugin/` that opens an activity tab and narrows the Agents list to the agents the portal touched. It cannot send input to a pane.
_Avoid_: Extension, add-on

## The public address

**Public address**:
The address a caller outside the owner's machine uses to reach the portal through the tunnel.
_Avoid_: Endpoint, URL, hostname

**Tunnel connection**:
One of the connections the tunnel keeps open to Cloudflare. A request from outside reaches the portal only while at least one is up.
_Avoid_: Link, channel

**Outage**:
A stretch in which the tunnel has no connection to Cloudflare. The public address cannot reach the portal, which keeps answering on the owner's machine.
_Avoid_: Downtime, disconnect

## What the portal remembers

**Ledger**:
The durable record of every write and its result, kept by idempotency key so that a repeat is answered without sending twice.
_Avoid_: Log, history

**Audit log**:
One line per write or file drop, refusals included, written for the owner to read afterwards.
_Avoid_: Journal, trace

**Needs review**:
The result of a write whose outcome is uncertain. The portal never retries it; the caller looks at the pane first.
_Avoid_: Unknown, pending, timeout

**Drop root**:
The one directory a file drop may write into.
_Avoid_: Inbox, upload folder

## Proof

**Proof matrix**:
The generated table that ties each action to the Herdr call it makes and the documentation it was checked against.
_Avoid_: Compatibility table

**Receipt**:
The saved result of a live run against a real Herdr, valid only for the source and Herdr build it ran on.
_Avoid_: Test report, log
