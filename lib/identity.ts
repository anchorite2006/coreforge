// The single identity this forge serves.
//
// The suite drives the API with one bearer token and addresses repositories
// under the token owner's login. A personal forge has exactly one user, so
// the viewer is a constant of the deployment rather than a database row:
// every surface (REST, GraphQL, MCP, git author lines) reads it from here so
// the surfaces can never disagree about who the caller is.

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

/** The branch a fresh repository points its HEAD at. */
export const DEFAULT_BRANCH = 'main';

/** The full ref HEAD resolves to in a fresh repository. */
export const DEFAULT_HEAD_REF = `refs/heads/${DEFAULT_BRANCH}`;
