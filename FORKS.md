# Forks and pull requests

The working changes are preserved on `fix/as3pb-benchmark` in these forks:

- https://github.com/33TU/avm2
- https://github.com/33TU/playerglobal
- https://github.com/33TU/swf-loader
- https://github.com/33TU/awayfl-player

In the existing workspace, `origin` points to your fork using the `github-33tu`
SSH alias; `upstream` points to the original AwayFL repository. GitHub CLI's
repository default is your fork. Local `dev` branches still track `upstream/dev`.
The working checkouts remain on `fix/as3pb-benchmark`, tracking the matching fork
branches. No PRs have been merged into either your fork's `dev` or AwayFL.

## Review and merge

All PRs start as drafts. Except for the stacked optimization, they target `dev`
in your own fork.

| Repository | PR | Branch | Dependency |
| --- | --- | --- | --- |
| swf-loader | [Fix loading and final flushing of LZMA-compressed SWFs](https://github.com/33TU/swf-loader/pull/1) | `fix/lzma-swf-input` | Independent |
| avm2 | [Implement FINDDEF in analysis, interpreter, and JIT](https://github.com/33TU/avm2/pull/1) | `fix/finddef-opcode` | Independent |
| playerglobal | [Avoid runtime access to the erased MouseButtons enum](https://github.com/33TU/playerglobal/pull/1) | `fix/mouse-button-mask` | Independent |
| avm2 | [Enable domain-memory instructions and track ByteArray storage changes](https://github.com/33TU/avm2/pull/2) | `fix/domain-memory-storage` | Use together with playerglobal memory binding |
| playerglobal | [Bind domain memory to native ByteArray storage without hot-path logging](https://github.com/33TU/playerglobal/pull/2) | `fix/domain-memory-binding` | Requires AVM2 domain memory |
| avm2 | [Correct AMF3 vector encoding and preserve ByteArray payloads](https://github.com/33TU/avm2/pull/3) | `fix/amf3-vectors-bytearrays` | Independent |
| avm2 | [Cache resolved slot writes in domain-memory methods](https://github.com/33TU/avm2/pull/4) | `perf/domain-memory-slot-writes` | Stacked on AVM2 domain memory |
| awayfl-player | [Add the AS3PB benchmark with local runtime builds and regression checks](https://github.com/33TU/awayfl-player/pull/1) | `chore/as3pb-benchmark` | Uses the runtime PRs above |

LZMA, FINDDEF, mouse buttons, and AMF3 can be reviewed and merged independently.
Use the AVM2 domain-memory and playerglobal binding changes together: generated
memory instructions depend on the binding supplied by playerglobal.

The slot-write optimization targets `fix/domain-memory-storage`, keeping its
review diff limited to the optimization. Merge the storage PR first, then retarget
the optimization PR to `dev`. A merge commit preserves the shared ancestry. If
you squash or rebase-merge the storage PR, rebase only the optimization commits
onto the new `dev` before retargeting, so the already merged changes are not
reintroduced. Keep the base branch until the stacked PR is retargeted.

The benchmark PR includes the build setup and regression checks shared by these
repos. The combined topic branches reproduce the original runtime integration
trees exactly. Both focused check scripts pass; AVM2's integration branch and all
four AVM2 topic branches pass TypeScript compilation. Prior browser/build checks
and performance limitations are documented in [BENCHMARK.md](BENCHMARK.md).

## Run the complete working version

The `fix/as3pb-benchmark` branches contain all fixes and can be used while the
individual PRs are under review. In a fresh parent directory:

```sh
for repo in avm2 playerglobal swf-loader awayfl-player; do
    git clone --branch fix/as3pb-benchmark "https://github.com/33TU/$repo.git"
done
cd awayfl-player
npm install
npm run build:prod
python3 -m http.server 8082 --bind 127.0.0.1 --directory bin
```

Open http://127.0.0.1:8082/as3pb-bench/index.html. In the existing workspace,
`just prod` from the parent directory runs the same build and server; that
parent-level justfile is outside these four Git repositories.

## Start the next independent PR

Inside the repository you want to change:

```sh
git fetch origin
git switch -c fix/describe-the-change origin/dev
# Edit, verify, and commit the change.
git push -u origin HEAD
```

Create the PR with your fork as the explicit target, for example:

```sh
gh pr create --repo 33TU/avm2 --base dev --draft
```

Use the 33TU GitHub CLI account when creating or editing these PRs. The initial
setup left the machine's globally active account unchanged; local Git pushes use
the existing `github-33tu` SSH identity.

Fetch upstream changes with `git fetch upstream`. Review and bring them into your
fork's `dev` separately, preserving any fixes you have already merged there.
Keep new independent work based on `origin/dev`; use a topic branch as the base
only when deliberately stacking a dependent PR.
