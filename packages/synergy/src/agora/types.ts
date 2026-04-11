import z from "zod"

export namespace AgoraTypes {
  export const ActorSummary = z.object({
    id: z.string(),
    display_name: z.string(),
    actor_type: z.enum(["human", "agent"]),
  })
  export type ActorSummary = z.infer<typeof ActorSummary>

  export const Actor = z.object({
    id: z.string(),
    platform_type: z.string(),
    platform_actor_id: z.string(),
    actor_type: z.enum(["human", "agent"]),
    display_name: z.string(),
    avatar_url: z.string().nullable().optional(),
    status: z.enum(["active", "disabled", "deleted"]),
    meta: z.record(z.string(), z.any()).nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  export type Actor = z.infer<typeof Actor>

  export const GitPostFields = z.object({
    repo_name: z.string().optional(),
    current_main_commit_sha: z.string().optional(),
  })
  export type GitPostFields = z.infer<typeof GitPostFields>

  export const GitAnswerFields = z.object({
    branch_name: z.string().optional(),
    base_commit_sha: z.string().optional(),
    head_commit_sha: z.string().nullable().optional(),
    branch_clone_url: z.string().nullable().optional(),
    branch_clone_command: z.string().nullable().optional(),
  })
  export type GitAnswerFields = z.infer<typeof GitAnswerFields>

  export const PostSummary = z
    .object({
      id: z.string(),
      title: z.string(),
      description_preview: z.string().optional(),
      tags: z.array(z.string()),
      bounty: z.number(),
      status: z.enum(["open", "closed", "deleted"]),
      accepted_answer_id: z.string().nullable().optional(),
      answer_count: z.number(),
      comment_count: z.number(),
      author_actor: ActorSummary,
      created_at: z.string(),
      updated_at: z.string(),
    })
    .extend(GitPostFields.shape)
  export type PostSummary = z.infer<typeof PostSummary>

  export const PostDetail = z
    .object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      tags: z.array(z.string()),
      bounty: z.number(),
      status: z.enum(["open", "closed", "deleted"]),
      accepted_answer_id: z.string().nullable().optional(),
      latest_version_no: z.number(),
      answer_count: z.number(),
      comment_count: z.number(),
      author_actor: ActorSummary,
      permissions: z
        .object({
          can_edit: z.boolean(),
          can_delete: z.boolean(),
          can_close: z.boolean(),
          can_answer: z.boolean(),
          can_comment: z.boolean(),
          can_accept_answer: z.boolean(),
        })
        .optional(),
      closed_at: z.string().nullable().optional(),
      closed_by_actor_id: z.string().nullable().optional(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .extend(GitPostFields.shape)
  export type PostDetail = z.infer<typeof PostDetail>

  export const AnswerSummary = z
    .object({
      id: z.string(),
      post_id: z.string(),
      text_preview: z.string().optional(),
      text: z.string().optional(),
      status: z.enum(["active", "accepted", "deleted"]),
      is_accepted: z.boolean(),
      latest_version_no: z.number(),
      author_actor: ActorSummary,
      created_at: z.string(),
      updated_at: z.string(),
    })
    .extend(GitAnswerFields.shape)
  export type AnswerSummary = z.infer<typeof AnswerSummary>

  export const AnswerDetail = z
    .object({
      id: z.string(),
      post_id: z.string(),
      text: z.string(),
      status: z.enum(["active", "accepted", "deleted"]),
      is_accepted: z.boolean(),
      latest_version_no: z.number(),
      author_actor: ActorSummary,
      accepted_at: z.string().nullable().optional(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .extend(GitAnswerFields.shape)
  export type AnswerDetail = z.infer<typeof AnswerDetail>

  export const Comment = z.object({
    id: z.string(),
    post_id: z.string(),
    parent_type: z.enum(["post", "answer", "comment"]),
    parent_id: z.string(),
    root_comment_id: z.string().nullable().optional(),
    depth: z.number(),
    content: z.string().optional(),
    status: z.enum(["active", "deleted"]),
    author_actor: ActorSummary,
    created_at: z.string(),
  })
  export type Comment = z.infer<typeof Comment>

  export const SSHKeyRecord = z.object({
    id: z.number(),
    key: z.string(),
    title: z.string(),
    fingerprint: z.string().optional(),
    created_at: z.string().optional(),
    read_only: z.boolean().optional(),
    verified: z.boolean().optional(),
  })
  export type SSHKeyRecord = z.infer<typeof SSHKeyRecord>

  export const SSHKeyList = z.object({
    items: z.array(SSHKeyRecord),
  })
  export type SSHKeyList = z.infer<typeof SSHKeyList>

  export const RepoOwner = z.object({
    id: z.number().optional(),
    login: z.string(),
    full_name: z.string().optional(),
  })
  export type RepoOwner = z.infer<typeof RepoOwner>

  export const RepoInfo = z.object({
    repo_name: z.string(),
    owner_gitea_user_id: z.string().optional(),
    repo: z
      .object({
        id: z.number().optional(),
        name: z.string(),
        full_name: z.string().optional(),
        default_branch: z.string().optional(),
        ssh_url: z.string().optional(),
        clone_url: z.string().optional(),
        html_url: z.string().optional(),
        owner: RepoOwner.optional(),
      })
      .passthrough()
      .optional(),
  })
  export type RepoInfo = z.infer<typeof RepoInfo>

  export const CommitIdentity = z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    date: z.string().optional(),
  })
  export type CommitIdentity = z.infer<typeof CommitIdentity>

  export const CommitInfo = z.object({
    id: z.string().optional(),
    sha: z.string().optional(),
    message: z.string().optional(),
    url: z.string().optional(),
    author: CommitIdentity.optional(),
    committer: CommitIdentity.optional(),
    created: z.string().optional(),
    html_url: z.string().optional(),
  })
  export type CommitInfo = z.infer<typeof CommitInfo>

  export const BranchInfo = z.object({
    name: z.string(),
    protected: z.boolean().optional(),
    enable_status_check: z.boolean().optional(),
    user_can_push: z.boolean().optional(),
    user_can_merge: z.boolean().optional(),
    effective_branch_protection_name: z.string().optional(),
    commit: CommitInfo.optional(),
  })

  export const BranchListResponse = z.object({
    post_id: z.string().optional(),
    repo_name: z.string().optional(),
    branches: z.array(BranchInfo),
  })
  export type BranchInfo = z.infer<typeof BranchInfo>
  export type BranchListResponse = z.infer<typeof BranchListResponse>

  export const TreeEntry = z.object({
    name: z.string().optional(),
    path: z.string(),
    mode: z.string().optional(),
    type: z.enum(["blob", "tree", "commit", "file", "dir", "symlink"]),
    size: z.number().optional(),
    sha: z.string().optional(),
    url: z.string().optional(),
  })
  export type TreeEntry = z.infer<typeof TreeEntry>

  export const TreeResponse = z.object({
    post_id: z.string().optional(),
    repo_name: z.string().optional(),
    ref: z.string().optional(),
    path: z.string().optional(),
    page: z.number().optional(),
    total_count: z.number().optional(),
    sha: z.string().optional(),
    tree: z.array(TreeEntry).optional(),
    items: z.array(TreeEntry).optional(),
    truncated: z.boolean().optional(),
  })
  export type TreeResponse = z.infer<typeof TreeResponse>

  export const BlobResponse = z.object({
    content: z.string(),
    encoding: z.string().optional(),
    sha: z.string().optional(),
    size: z.number().optional(),
    url: z.string().optional(),
    is_binary: z.boolean().optional(),
  })
  export type BlobResponse = z.infer<typeof BlobResponse>

  export const AnswerCommit = z.object({
    sha: z.string(),
    message: z.string().optional(),
    html_url: z.string().optional(),
    created: z.string().optional(),
    author: z.any().optional(),
    committer: z.any().optional(),
    commit: z
      .object({
        author: CommitIdentity.optional(),
        committer: CommitIdentity.optional(),
        message: z.string().optional(),
      })
      .optional(),
    files: z.array(z.lazy(() => CompareFile)).optional(),
    stats: z
      .object({
        total: z.number().optional(),
        additions: z.number().optional(),
        deletions: z.number().optional(),
      })
      .optional(),
  })
  export type AnswerCommit = z.infer<typeof AnswerCommit>

  export const AnswerCommitListResponse = z.object({
    items: z.array(AnswerCommit),
  })
  export type AnswerCommitListResponse = z.infer<typeof AnswerCommitListResponse>

  export const CompareFile = z.object({
    filename: z.string(),
    status: z.string().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    changes: z.number().optional(),
    patch: z.string().optional(),
    previous_filename: z.string().optional(),
  })
  export type CompareFile = z.infer<typeof CompareFile>

  export const CompareResponse = z.object({
    base_commit_sha: z.string().optional(),
    head_commit_sha: z.string().optional(),
    compare: z
      .object({
        commit_url: z.string().optional(),
        html_url: z.string().optional(),
        permalink_url: z.string().optional(),
        patch: z.string().optional(),
        diff: z.string().optional(),
        files: z.array(CompareFile).optional(),
        commits: z.array(AnswerCommit).optional(),
        base_commit: AnswerCommit.optional(),
        merge_base_commit: AnswerCommit.optional(),
        total_commits: z.number().optional(),
        ahead_by: z.number().optional(),
        behind_by: z.number().optional(),
        status: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  export type CompareResponse = z.infer<typeof CompareResponse>

  export const DiffFile = z.object({
    old_name: z.string().optional(),
    new_name: z.string().optional(),
    is_created: z.boolean().optional(),
    is_deleted: z.boolean().optional(),
    is_rename: z.boolean().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    patch: z.string().optional(),
  })
  export type DiffFile = z.infer<typeof DiffFile>

  export const DiffResponse = z.object({
    patch: z.string().optional(),
    is_binary: z.boolean().optional(),
    base_commit_sha: z.string().optional(),
    head_commit_sha: z.string().optional(),
    commits: z.array(AnswerCommit).optional(),
    files: z.array(DiffFile).optional(),
  })
  export type DiffResponse = z.infer<typeof DiffResponse>

  export const ApiResponse = <T extends z.ZodType>(data: T) =>
    z.object({
      code: z.number(),
      message: z.string(),
      data,
    })
}
