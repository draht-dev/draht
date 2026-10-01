/**
 * Hand-maintained stand-in for the file `sst dev`/`sst build` normally generates at the package
 * root. This environment cannot run those commands, so the `Resource` shape is declared here;
 * regenerating against the real deploy should produce an equivalent augmentation.
 */
declare module "sst" {
	export interface Resource {
		BugReports: {
			type: "sst.aws.Bucket";
			name: string;
		};
	}
}

export {};
