---
description: Address a PR review and request another review
argument-hint: "<pr-number>"
---
The PR #$1 has got a review, and you need to deal with it.

For each change consider whether that change actually is good to have or not - don't
automatically assume it is.

For all the changes that are good to have, implement them all and push to
the PR, and make sure that all relevant checks, tests and an external review
passes.

If the PR implements anything visual, like updating the frontend or updating an
application, then you should start up a test application for me to test. Remember to
close the test application when we're done with the review.

You should write a checklist for me here in the chat of things I need to check, related
to the PR. You need my approval before continuing.

When you've done that then add comments to all line-level comments and resolve all the
ones you implemented. For the ones you didn't think were good to have, you add a comment
but don't resolve them. You also add an overall comment on the PR stating that you've
now implemented XYZ and that it's ready for another review.

Request a review from the same person/bot that submitted the review. You should then
remove the local branch, so that it's all cleaned up in case the PR is simply approved
and merged.
