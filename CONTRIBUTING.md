## How to Contribute

Provenance is a project under active development. New contributors should expect a workflow where
ProvenanceTools/provenance is the source of truth central repository, and all work should occur on
branches from a forked repo <gh-user/provenance:<your-branch-name>. 

After building and testing your changes, make sure your repo is synced and up-to-date with the main repository and then test again.

After all tests pass, make a pull request (PR) requesting the changes be integrated into the main repository after review

## Workflow
1) Fork the repository to your own GitHub account
2) Clone the repository and set up project so it runs in your development environment
3) create a branch for the single feature you're developing, and cook
4) The feature on the branch has been built and tested, which may include submitting additional tests.
5) Make a pull request (PR) for your changes to be reviewed, there may be lots of back and forth and changes requested at this step
6) All changes have been reviewed, and maintainers will merge your branch into the main repository. Woo!
7) Sync your repo so your downstream repository has all the new changes
8) Delete the branch, and start a new feature branch to make a new contribution. 

## Notes
- in general, small git commits are easier for review and easier to revert from in case of catastrophe
- Do not offer multiple major feature changes in the same branch. Keeps the merging of branches and review process cleaner
