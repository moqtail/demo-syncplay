export interface FragmentRange {
  startGroupId: number;
  startObjectId: number;
  endGroupId: number;
  endObjectId: number;
}

export interface RequestState {
  isLoading: boolean;
  error: string | null;
}