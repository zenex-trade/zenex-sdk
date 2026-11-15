/** One violated architecture invariant. */
export interface ArchitectureDiagnostic {
    file: string;
    line: number;
    rule: string;
    message: string;
}

/** Whether a source path belongs to the exact (float-free) surface. */
export function isExactModulePath(path: string): boolean;

/** Check every source file under `root/src`. Resolves to the violations found. */
export function checkArchitecture(root?: string): Promise<ArchitectureDiagnostic[]>;
