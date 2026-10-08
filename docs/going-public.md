# Going public

A checklist for the maintainer, in order. Nothing here runs by itself. Steps 1 and 3 cannot be undone once the repository is public.

## 1. Rewrite the history

The commits carry a personal e-mail as author and committer, and the session notes (`STATUS.md`) are in the history. One `git filter-repo` pass fixes both. Run it on a fresh clone, never on a working checkout.

```
git clone https://github.com/bardak971/afflatus.git afflatus-public
cd afflatus-public
printf '%s\n' 'bardak971 <7248933+bardak971@users.noreply.github.com> <old-address>' > ../mailmap.txt
git filter-repo --mailmap ../mailmap.txt --path STATUS.md --invert-paths
```

Replace `<old-address>` with the address the commits carry (`git log --format='%ae' | sort -u` lists them); add one line per address to map.

The tags move onto the rewritten commits. Check who each one names:

```
git for-each-ref refs/tags --format='%(refname:short) %(taggeremail)'
```

Re-create any tag that still names the old address, on the commit it points at, with the noreply address set as `user.email`:

```
git tag -f -a v0.2.1 -m "Afflatus v0.2.1" v0.2.1^{commit}
```

Push the result to a **re-created** repository, not a force-push: GitHub keeps the old commits reachable by their SHA for a while, and forks and caches keep them too.

1. On GitHub, rename the old repository (`afflatus-old`) and keep it private.
2. Create a new, empty, private `afflatus`.
3. Turn its Actions off first (Settings → Actions → Disable), or pushing the tags starts one release run per tag.
4. Push: `git remote add origin git@github.com:bardak971/afflatus.git && git push origin --all && git push origin --tags`.
5. Turn Actions back on. Connect the GHCR package to the new repository (the package's settings → Manage Actions access: give the new repository write access), or the next release cannot push its image.
6. Re-create the GitHub releases if they are wanted (their bundles can be downloaded from the old repository first), and any repository settings the old one had.
7. Delete the old repository once the checks of section 4 pass.

## 2. Make the image public

The package page (github.com/users/bardak971/packages/container/afflatus) → Package settings → Change visibility → Public. Without it, `docker run ghcr.io/bardak971/afflatus` fails for everyone else.

## 3. Make the repository public

Settings → General → Danger Zone → Change visibility → Public.

## 4. Verify

From another machine, or logged out:

```
git clone https://github.com/bardak971/afflatus.git check && cd check
git log --all --format='%ae %ce' | sort -u                 # only the noreply address
git for-each-ref refs/tags --format='%(taggeremail)' | sort -u
git log --all --oneline -- STATUS.md 'HANDOVER*'           # nothing
git log --all -p | grep -n -i -E '<old-address>|C:/Users/|[A-Z]:\\|192\.168\.[0-9]|<private-name>'   # nothing
docker pull ghcr.io/bardak971/afflatus:latest              # works without a login
```

`<private-name>` stands for whatever else must not be published: machine names, a home domain, a LAN address. Then open the repository and the package page in a private browser window.
