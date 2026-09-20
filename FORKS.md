# Forks and pull requests

The `dev` branches contain the merged runtime and benchmark PRs in these forks:

- https://github.com/33TU/avm2
- https://github.com/33TU/playerglobal
- https://github.com/33TU/swf-loader
- https://github.com/33TU/awayfl-player

In the existing workspace, `origin` points to your fork using the `github-33tu`
SSH alias; `upstream` points to the original AwayFL repository. GitHub CLI's
repository default is your fork, and default Git pushes go to `origin`. Local
checkouts use `dev`, tracking `origin/dev`. The topic branches and original
`fix/as3pb-benchmark` integration branches remain available. These PRs are merged
only into your forks; the original AwayFL repositories are unchanged.

## Merged PRs

All eight PRs were merged into the corresponding fork's `dev` using merge commits,
preserving their individual commits and branches.

| Repository | PR | Branch | Dependency |
| --- | --- | --- | --- |
| swf-loader | [Fix loading and final flushing of LZMA-compressed SWFs](https://github.com/33TU/swf-loader/pull/1) | `fix/lzma-swf-input` | Independent |
| avm2 | [Implement FINDDEF in analysis, interpreter, and JIT](https://github.com/33TU/avm2/pull/1) | `fix/finddef-opcode` | Independent |
| playerglobal | [Avoid runtime access to the erased MouseButtons enum](https://github.com/33TU/playerglobal/pull/1) | `fix/mouse-button-mask` | Independent |
| avm2 | [Enable domain-memory instructions and track ByteArray storage changes](https://github.com/33TU/avm2/pull/2) | `fix/domain-memory-storage` | Use together with playerglobal memory binding |
| playerglobal | [Bind domain memory to native ByteArray storage without hot-path logging](https://github.com/33TU/playerglobal/pull/2) | `fix/domain-memory-binding` | Requires AVM2 domain memory |
| avm2 | [Correct AMF3 vector encoding and preserve ByteArray payloads](https://github.com/33TU/avm2/pull/3) | `fix/amf3-vectors-bytearrays` | Independent |
| avm2 | [Cache resolved slot writes in domain-memory methods](https://github.com/33TU/avm2/pull/4) | `perf/domain-memory-slot-writes` | Follows AVM2 domain memory |
| awayfl-player | [Add the AS3PB benchmark with local runtime builds and regression checks](https://github.com/33TU/awayfl-player/pull/1) | `chore/as3pb-benchmark` | Uses the runtime PRs above |

LZMA, FINDDEF, mouse buttons, and AMF3 were independent changes. The AVM2
domain-memory and playerglobal binding changes are used together: generated
memory instructions depend on the binding supplied by playerglobal.

The slot-write optimization originally targeted `fix/domain-memory-storage`.
After merging the storage PR, the optimization was retargeted to `dev` and merged
there. Future dependent PRs can use the same sequence. Preserve the base commits
with a merge commit; if a base PR is squash-merged instead, rebase the dependent
commits onto the updated `dev` before retargeting.

The benchmark PR includes the build setup and regression checks shared by these
repos. The combined topic branches reproduce the original runtime integration
trees exactly. Both focused check scripts pass; AVM2's integration branch and all
four AVM2 topic branches pass TypeScript compilation. Prior browser/build checks
and performance limitations are documented in [BENCHMARK.md](BENCHMARK.md).

## Run the complete working version

Use the `dev` branches together for the complete working version. The original
`fix/as3pb-benchmark` branches remain as integration snapshots. In a fresh parent
directory:

```sh
for repo in avm2 playerglobal swf-loader awayfl-player; do
    git clone --branch dev "https://github.com/33TU/$repo.git"
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
