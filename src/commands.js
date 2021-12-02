function ALWAYS_TRUE () { return true }

module.exports = [
  { ruleName: 'edited_issue', webhookName: 'issues.edited', ruleMatcher: ALWAYS_TRUE },
  { ruleName: 'demilestoned_issue', webhookName: 'issues.demilestoned', ruleMatcher: ALWAYS_TRUE },
  { ruleName: 'milestoned_issue', webhookName: 'issues.milestoned', ruleMatcher: ALWAYS_TRUE },
  { ruleName: 'reopened_pullrequest', webhookName: 'pull_request.reopened', ruleMatcher: ALWAYS_TRUE },
  { ruleName: 'reopened_issue', webhookName: 'issues.reopened', ruleMatcher: ALWAYS_TRUE },
  { ruleName: 'added_reviewer', webhookName: 'pull_request.review_requested', ruleMatcher: ALWAYS_TRUE }, // See https://developer.github.com/v3/activity/events/types/#pullrequestevent to get the reviewer
  {
    createsACard: true,
    ruleName: 'new_issue',
    webhookName: 'issues.opened',
    ruleMatcher: async (_, context, ruleArgs) => (ruleArgs.length > 0) ? ruleArgs.indexOf(context.payload.repository.name) >= 0 : true
  },
  {
    ruleName: 'close_issue',
    webhookName: 'project_card.moved',
    ruleMatcher: ALWAYS_TRUE,
    updateCard: async (logger, context, data) => {
      if (data && !data.closed) {
        logger.info(`Closing Issue ${data.number}`)
        const result = await context.github.graphql(`
          mutation closeCard($issueId: ID!) {
            closeIssue(input: {issueId: $issueId}) {
              clientMutationId
            }
          }
        `, { issueId: data.id })

        logger.info(`Result of closing issue: ${result}`)
      }
    }
  },
  {
    createsACard: true,
    ruleName: 'new_pullrequest',
    webhookName: 'pull_request.opened',
    ruleMatcher: async (_, context, ruleArgs) => (ruleArgs.length > 0) ? ruleArgs.indexOf(context.payload.repository.name) >= 0 : true
  },
  {
    ruleName: 'merged_pullrequest',
    webhookName: 'pull_request.closed',
    ruleMatcher: async (_, context, _ruleArgs) => !!context.payload.pull_request.merged
  },
  {
    ruleName: 'closed_pullrequest',
    webhookName: 'pull_request.closed',
    ruleMatcher: async (_, context, _ruleArgs) => !!context.payload.pull_request.merged
  },
  {
    ruleName: 'assigned_to_issue',
    webhookName: 'issues.assigned',
    ruleMatcher: async (logger, context, ruleArgs) => {
      if (ruleArgs[0] !== true) {
        return context.payload.assignee.login === ruleArgs[0]
      } else {
        logger.error(`assigned_to.issue requires a username but it is missing`)
      }
    }
  },
  {
    ruleName: 'assigned_issue',
    webhookName: 'issues.assigned',
    ruleMatcher: async (_, context, _ruleArgs) => context.payload.issue.assignees.length === 1
  },
  {
    ruleName: 'unassigned_issue',
    webhookName: 'issues.unassigned',
    ruleMatcher: async (_, context, _ruleArgs) => context.payload.issue.assignees.length === 0
  },
  {
    ruleName: 'assigned_pullrequest',
    webhookName: 'pull_request.assigned',
    ruleMatcher: async (_, context, _ruleArgs) => context.payload.pull_request.assignees.length === 1
  },
  {
    ruleName: 'unassigned_pullrequest',
    webhookName: 'pull_request.unassigned',
    ruleMatcher: async (_, context, _ruleArgs) => context.payload.pull_request.assignees.length === 0
  },
  {
    ruleName: 'added_label',
    webhookName: 'issues.labeled',
    ruleMatcher: async (_, context, ruleArgs) => (context.payload.label.name === ruleArgs[0] || context.payload.label.id === ruleArgs[0])
  },
  {
    ruleName: 'add_close_issue',
    webhookName: 'issues.labeled',
    ruleMatcher: ALWAYS_TRUE,
    updateCard: async (logger, context, data, args) => {
      const repos = args.ruleArgs.slice(1).map(repo => `**${repo}**`).join(' ')
      const CLOSE_PROJECT_CARD = '###### Automation Rules\r\n\r\n<!-- Documentation: https://github.com/philschatz/project-bot -->\r\n\r\n- `close_issue` ' + repos

      logger.info(`Adding close issue rule card`)
      const cardsForIssue = data.projectCards ? data.projectCards.nodes : []
      for (const issueCard of cardsForIssue) {
        const column = issueCard.project.columns.nodes.find(({ name }) => name === args.ruleArgs[0])
        if (column && column.firstCards.nodes.concat(column.lastCards.nodes).every(({ note }) => note !== CLOSE_PROJECT_CARD)) {
          const result = await context.github.graphql(`
            mutation addCard($note: String!, $projectColumnId: ID!) {
              addProjectCard(input: {note: $note, projectColumnId: $projectColumnId}) {
                cardEdge {
                  node {
                    id
                  }
                }
              }
            }
          `, { note: CLOSE_PROJECT_CARD, projectColumnId: column.id })

          logger.info(`Result of adding project card: ${result}`)
          const closeCardId = result ? result.addProjectCard.cardEdge.node.id : null
          return {
            columnId: column.id,
            closeCardId,
            lastCardInCloseColumnId: column.lastCards.nodes[column.lastCards.nodes.length - 1].id
          }
        }
      }
    }
  },
  {
    ruleName: 'added_label',
    webhookName: 'pull_request.labeled',
    ruleMatcher: async (_, context, ruleArgs) => (context.payload.label.name === ruleArgs[0] || context.payload.label.id === ruleArgs[0])
  },
  {
    ruleName: 'removed_label',
    webhookName: 'issues.unlabeled',
    ruleMatcher: async (_, context, ruleArgs) => (context.payload.label.name === ruleArgs[0] || context.payload.label.id === ruleArgs[0])
  },
  {
    ruleName: 'removed_label',
    webhookName: 'pull_request.unlabeled',
    ruleMatcher: async (_, context, ruleArgs) => (context.payload.label.name === ruleArgs[0] || context.payload.label.id === ruleArgs[0])
  },
  {
    ruleName: 'accepted_pullrequest',
    webhookName: 'pull_request_review.submitted',
    ruleMatcher: async (_, context, _ruleArgs) => {
      // See https://developer.github.com/v3/activity/events/types/#pullrequestreviewevent
      // Check if there are any Pending or Rejected reviews and ensure there is at least one Accepted one
      const issue = context.issue()
      const { data: reviews } = await context.github.pullRequests.listReviews({ owner: issue.owner, repo: issue.repo, pull_number: issue.number })
      // Check that there is at least one Accepted
      const hasAccepted = reviews.filter((review) => review.state === 'APPROVED').length >= 1
      const hasRejections = reviews.filter((review) => review.state === 'REQUEST_CHANGES').length >= 1
      const hasPending = reviews.filter((review) => review.state === 'PENDING').length >= 1
      if (hasAccepted && !hasRejections && !hasPending) {
        return true
      } else {
        return false
      }
    }
  }
]
