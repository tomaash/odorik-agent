import {
  githubInstallationToken,
  type FetchLike,
  type GitHubAppConfiguration,
} from "../connectors/github.js";

export type GitHubPublicationSnapshot = {
  branchSha: string | null;
  pullRequest: {
    number: number;
    url: string;
    draft: boolean;
    state: "open" | "closed";
    mergedAt: string | null;
    headSha: string;
    headBranch: string;
    baseBranch: string;
  } | null;
};

async function githubRead<T>(input: {
  fetcher: FetchLike;
  token: string;
  path: string;
  allowNotFound?: boolean;
}): Promise<T | null> {
  const response = await input.fetcher(`https://api.github.com${input.path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "user-agent": "agent-erik-coding-recovery",
      "x-github-api-version": "2026-03-10",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404 && input.allowNotFound) return null;
  const body = await response.json() as T & { message?: string };
  if (!response.ok) {
    throw new Error(`GitHub recovery lookup failed (${response.status}): ${body.message || "unknown"}`);
  }
  return body;
}

export async function inspectGitHubPublication(input: {
  configuration: GitHubAppConfiguration;
  installationId: number;
  repositoryId: number;
  fullName: string;
  resultBranch: string;
  baseBranch: string;
  fetcher?: FetchLike;
}): Promise<GitHubPublicationSnapshot> {
  const fetcher = input.fetcher || fetch;
  const [owner, repo, ...extra] = input.fullName.split("/");
  if (!owner || !repo || extra.length) throw new Error("Invalid GitHub repository name");
  const installation = await githubInstallationToken({
    configuration: input.configuration,
    installationId: input.installationId,
    fetcher,
  });
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const repository = await githubRead<{ id: number; full_name: string }>({
    fetcher,
    token: installation.token,
    path: prefix,
  });
  if (
    repository?.id !== input.repositoryId
    || repository.full_name.toLowerCase() !== input.fullName.toLowerCase()
  ) throw new Error("GitHub repository no longer matches the approved run");

  const branch = await githubRead<{ object?: { sha?: string } }>({
    fetcher,
    token: installation.token,
    path: `${prefix}/git/ref/heads/${input.resultBranch.split("/").map(encodeURIComponent).join("/")}`,
    allowNotFound: true,
  });
  const branchSha = branch ? String(branch.object?.sha || "").toLowerCase() : null;
  if (branchSha !== null && !/^[a-f0-9]{40,64}$/.test(branchSha)) {
    throw new Error("GitHub returned an invalid result branch SHA");
  }

  const query = new URLSearchParams({
    state: "all",
    head: `${owner}:${input.resultBranch}`,
    base: input.baseBranch,
    per_page: "10",
  });
  const pulls = await githubRead<Array<{
    number: number;
    html_url: string;
    draft?: boolean;
    state: "open" | "closed";
    merged_at?: string | null;
    head?: { sha?: string; ref?: string };
    base?: { ref?: string };
  }>>({
    fetcher,
    token: installation.token,
    path: `${prefix}/pulls?${query}`,
  }) || [];
  if (pulls.length > 1) {
    throw new Error("Multiple pull requests use the approved result branch");
  }
  const pull = pulls[0];
  if (!pull) return { branchSha, pullRequest: null };
  const headSha = String(pull.head?.sha || "").toLowerCase();
  if (
    !Number.isSafeInteger(pull.number)
    || pull.number <= 0
    || !/^https:\/\/github\.com\//.test(pull.html_url)
    || !/^[a-f0-9]{40,64}$/.test(headSha)
    || pull.head?.ref !== input.resultBranch
    || pull.base?.ref !== input.baseBranch
    || !["open", "closed"].includes(pull.state)
  ) throw new Error("GitHub returned an invalid pull request snapshot");
  return {
    branchSha,
    pullRequest: {
      number: pull.number,
      url: pull.html_url,
      draft: pull.draft === true,
      state: pull.state,
      mergedAt: pull.merged_at || null,
      headSha,
      headBranch: input.resultBranch,
      baseBranch: input.baseBranch,
    },
  };
}
