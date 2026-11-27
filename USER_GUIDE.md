# TwinTrack Master: User Guide

For everyone who signs in to TwinTrack, and for administrators who manage people and access. How it works underneath is in [HOW_IT_WORKS.md](HOW_IT_WORKS.md).

## Getting started

TwinTrack Master is where everyone signs in, and where administrators decide who can do what in every module (Project management, Accounts and the rest). You sign in once; each module opens with the same sign-in.

**Your first sign-in**

1. Nobody is given a password. When an administrator adds you, TwinTrack emails you a one-time link.
2. Open the link and choose a password of at least 8 characters.
3. Sign in with your email address and that password.

**Forgot your password?** Ask an administrator to send a new link. Changing your password signs you out everywhere else.

**How long you stay signed in:** a session ends after 7 days without use, and after 30 days in any case. After too many wrong passwords, sign-in is paused for a while.

**Who uses Master**

| Who | What they do here |
| --- | --- |
| Everyone | Open their modules, look people up, see their own permissions and profile |
| Administrators | Add people, set managers and roles, build and give profiles, read the activity log |
| Super admin | Everything, including access nobody else can grant. Only a super admin can change another super admin |

## Finding your way

The menu has two parts: your own account, and the admin console. You only see the screens your profile allows.

**Your account (everyone)**

| Screen | What it is for |
| --- | --- |
| Your modules | The modules you can open. Click one to go to it |
| Directory | Look up colleagues: name, role, manager |
| Records | Records of the objects your organisation defined, and their history |
| Your permissions | Exactly what your profile lets you do, module by module |
| Your profile | Your name and details, and changing your password |
| Apps and API tokens | Connect Claude or another app to TwinTrack on your behalf |

**Admin console (administrators)**

| Screen | What it is for |
| --- | --- |
| Overview | Counts of people, profiles and modules at a glance |
| Modules | Each module, its version, what it can do, and its APIs |
| Roles | The tree of job levels (org roles), with one top role |
| Profiles | Build profiles: what each one allows in every module |
| People | Add people, set their manager, role and profile, send password links |
| Clients | The organisation's clients, shared by every module |
| Access | Who holds which profile, and changing it |
| API tokens | Tokens people made for apps, and revoking them |
| Activity log | Every sign-in and every change to access, with who and when |

## People

Every person has an email address, an org role, a manager and at most one profile. You need the People permissions to add or change them.

**Add a person**

1. Open **People** and press **Add a person**.
2. Enter their name and email address, and choose their org role and manager.
3. Save. TwinTrack emails them a one-time link to set their password.
4. Give them a profile (see the next section). Until then they can sign in but open no module.

**Managers and the reporting line.** A person's manager decides their team. "Team" access reaches you and everyone who reports to you, directly or through others. Two people at the same level each see only their own reporting line.

**Org roles** (the **Roles** screen) are job levels, such as Director or Project manager, in a tree with one top role. A role gives no access by itself. It is used when you share a record with "a role and everything below it".

**Deactivating someone** stops them signing in at once. A person whose name is still on records (a project, a voucher) can't be deleted; deactivate them instead.

## Profiles and access

A profile is the only source of a person's access: one profile per person, covering every module. Nothing ships ready-made, so a new organisation has no profiles until an administrator builds them.

**Build a profile**

1. Open **Profiles** and press **New profile**. Name it after the job, such as "Accountant".
2. For each module, tick what the profile may do with each kind of record: read, create, update, approve and so on.
3. Choose a reach for each permission (below), then save.

**Reach (scope)**

| Reach | What it covers | Example |
| --- | --- | --- |
| Own | Records the person made or that are about them | An employee sees their own salary |
| Team | Theirs, plus everyone in their reporting line | A project manager sees their developers' tasks |
| All | Every record in the organisation | The finance manager sees every voucher |

**Give a profile:** open the person under **People** or **Access** and choose the profile. You can only give a profile that stays within your own access, and only to people your reach covers (Team means your reporting line). This is how a manager hands access down without asking IT.

**When changes apply:** at once. The person's next click uses the new access, without signing in again.

## Modules, records and sharing

**Modules.** The **Modules** screen lists each module and what it can do. Super admins can add custom objects (your own kinds of record, with your own fields); they then appear under **Records** for people whose profile allows them.

**Sharing a record.** When someone outside your reach needs one record, share it instead of widening their profile. Share with a person, an org role, or a role and everyone below it, for **read** or **edit**. Sharing never adds a permission: the person must already be allowed that kind of record. The record's owner, anyone above them, or someone with the share permission may share.

**Field security.** A profile can hide a field (a salary, a bank number) or make it read-only, while the rest of the record stays visible. Hidden fields are also left out of history and exports.

**Record history.** Each record keeps who changed which field, from what to what, and when. Deleted records are kept and can be restored by people allowed to.

## Rules and common questions

These rules always apply, whatever a profile says:

- Nobody can change their own access: their own profile, org role or manager.
- Only a super admin can change a super admin.
- Only a super admin can build or give a profile beyond their own access.
- Every sign-in and every access change is written to the activity log.

| Question | Answer |
| --- | --- |
| I can't see a module | Your profile doesn't include it. Ask whoever gives profiles |
| A screen says my access doesn't include it | The same: your profile lacks that permission. Check **Your permissions** |
| I never got the password email | Check spam, then ask an administrator to send a new link |
| I changed someone's profile; do they need to sign in again? | No. It applies on their next click |
| Can I see a colleague's record outside my team? | Only if it is shared with you |
