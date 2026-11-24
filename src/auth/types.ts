export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export interface AuthWorkspace {
  id: string;
  name: string;
}

export interface AuthMe {
  user: AuthUser;
  workspace: AuthWorkspace;
}
