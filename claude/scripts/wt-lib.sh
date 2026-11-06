# Helpers shared by the wt-* scripts, which source this file.
#
# They reach GitHub through gh, as the account it is logged in to, so they need
# `gh auth login` first.

die() {
  echo "${0##*/}: $*" >&2
  exit 1
}

# Run git with GitHub reached over HTTPS, where gh supplies any credentials a
# repo needs, while SSH needs a key of its own. The empty helper drops every
# other credential helper for github.com, so git asks gh alone. Prompting is off
# so a repo that gh can't reach fails instead of waiting for input.
git_https() (
  export GIT_TERMINAL_PROMPT=0
  exec git -c url.https://github.com/.insteadOf=git@github.com: \
    -c credential.https://github.com.helper= \
    -c 'credential.https://github.com.helper=!gh auth git-credential' "$@"
)

# The <owner>/<name> of the GitHub repo that remote <remote> of checkout
# <checkout> points at.
github_repo() {
  local url repo
  url=$(git -C "$1" remote get-url "$2")
  repo=$(sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##' <<<"$url")
  [[ $repo =~ ^[^/:]+/[^/]+$ ]] || die "remote $2 is not a GitHub repository: $url"
  echo "$repo"
}

# GET a GitHub REST API path, such as repos/<owner>/<name>/pulls; any further
# arguments are passed to gh api, such as query parameters (-f <name>=<value>)
# or --paginate.
github_api() {
  gh api --method GET "$1" "${@:2}" || die "GitHub API request failed: $1"
}

# The PRs whose head is <branch> in GitHub repo <owner>/<name>, newest first, as
# a JSON array.
branch_prs() {
  github_api "repos/$1/pulls" -f "head=${1%%/*}:$2" -f state=all -f per_page=100 --paginate
}
