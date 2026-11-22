# jm-devkit

Joseph's personal development kit: the one place his way of building software lives, so every project is developed the same way and a change to that way is made once.

## Language

**Kit**:
The whole of jm-devkit: everything a project needs to be developed Joseph's way.
_Avoid_: devkit (the plugin's name), toolkit, tooling, flow

**Project**:
A repository that is developed with the kit. The kit never names or describes one, and the kit is itself a project.
_Avoid_: repo, consumer, app (what a project runs, and not every project has one)

**Plugin**:
The part of the kit that is present inside a Claude Code session: the skills and the house rules.
_Avoid_: devkit, extension

**Module**:
A part of the kit a project chooses to use. There are three: process, web and canvas.
_Avoid_: feature, package (a package is published code), layer

**Process module**:
How work is specified, ticketed, built, reviewed and closed. It fits a project in any language.
_Avoid_: workflow (a GitHub Actions file), issue system

**Web module**:
The shared conventions and checks for a project's web app.
_Avoid_: frontend config, lint setup

**Canvas module**:
The design canvas and everything that keeps it true to the project's real screens. It needs the web module.
_Avoid_: design system (the tokens and components a canvas is drawn with)

**Canvas engine**:
The shared code that builds a project's boards from its real screens and checks them. Each project supplies its own screens and demo data.
_Avoid_: canvas tooling, canvas scripts

**Code reviewer**:
The part of the kit that audits a project's code on GitHub and files what it finds as tickets.
_Avoid_: Code Reviewer (it is one process among others, not a proper noun), reviewer service, bot, sweep (one thing the code reviewer does)

**House rule**:
A rule that holds in every session of every project, whichever skill is running. House rules belong to the kit, never to a project.
_Avoid_: convention, standing instruction, agent rule

**Project config**:
A project's own declaration of how it uses the kit: its modules, and the facts about itself the kit needs.
_Avoid_: stamp, manifest, registration (what the apps machine holds for an app)

**Kit-owned file**:
A file in a project that the kit generates from the project config and replaces on every sync. A project changes it only through its project config. One the kit stops generating is **retired**: sync removes it from a project that still has it.
_Avoid_: managed file, template, generated file

**Project-owned file**:
A file in a project that install writes once if it is missing and the kit never touches again.
_Avoid_: scaffold, starter file

**House standard**:
A coding standard the code reviewer holds every project to, alongside the project's own standards.
_Avoid_: shared rule, house rule (which governs how agents work, not what the code must be)

**Install**:
Bringing a project under the kit, whether it is new or already has some of the pieces.
_Avoid_: setup, init, onboarding, bootstrap

**Sync**:
Bringing a project's own copies of kit files up to the kit's current state.
_Avoid_: update (what the plugin does on its own), upgrade

**Merge rule**:
The rule on a project's default branch on GitHub: a commit is there only through a pull request whose CI passed, and nobody may bypass that.
_Avoid_: branch protection (GitHub's older setting), merge gate, ruleset (how GitHub holds the rule)

**Development machine**:
The owner's machine that agents and the code reviewer work on unattended. It holds projects' checkouts and seeded data only, never an app's real data or production keys.
_Avoid_: dev VM, dev box, sandbox, server, the owner's machine (he owns both machines)

**Apps machine**:
The owner's machine that runs the real copies of his apps, and holds their real data and production keys. Only the owner acts on it: no agent, and not the code reviewer, has an account, a key or a route onto it.
_Avoid_: prod box, production server, server, host

**Registration**:
What the apps machine holds for an app it is to run: the app's name, its repository and the port it is reached on. The owner makes it by hand on the apps machine, and it is never in the project's repository.
_Avoid_: project config (a project's own declaration, kept in its repository), enrolment, app config

**Upstream**:
Matt Pocock's skills, which the plugin's skills were forked from and which are pulled in again only on purpose.
_Avoid_: mattpocock-skills (the plugin, no longer installed), overlay (the retired approach of tuning around unedited skills)
