const extractAutomationRules = require('./extract-rules')
const automationCommands = require('./commands')
const getIssueFromBody = require('./util')

// `await sleep(1000)` syntax
async function sleep (ms) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}
// Often, there is a delay between the webhook firing and GaphQL updating
async function retryQuery (context, query, args) {
  try {
    return await context.github.graphql(query, args)
  } catch (err) {
    await sleep(1000)
    return context.github.graphql(query, args)
  }
}

// Move the automation card to the bottom
async function updateRuleCard (context, afterId, cardId, columnId) {
  if (afterId) {
    await context.github.graphql(`
    mutation moveCard($cardId: ID!, $columnId: ID!, $afterId: ID!) {
      moveProjectCard(input: {cardId: $cardId, columnId: $columnId, afterCardId: $afterId}) {
        clientMutationId
      }
    }
  `, { cardId, columnId, afterId })
  }
}

// Common GraphQL Fragment for getting the Automation Cards out of the bottom of every Column in a Project
const PROJECT_FRAGMENT = `
  name
  id
  columns(first: 50) {
    totalCount
    nodes {
      id
      name
      url
      firstCards: cards(first: 1, archivedStates: NOT_ARCHIVED) {
        totalCount
        nodes {
          url
          id
          note
        }
      }
      lastCards: cards(last: 2, archivedStates: NOT_ARCHIVED) {
        totalCount
        nodes {
          url
          id
          note
        }
      }
    }
  }
`

module.exports = (robot) => {
  const logger = robot.log.child({ name: 'project-bot' })
  // Increase the maxListenerCount by the number of automationCommands
  // because we register a bunch of listeners
  robot.events.setMaxListeners(robot.events.getMaxListeners() + automationCommands.length)
  logger.info(`Starting up`)

  // Register all of the automation commands
  automationCommands.forEach(({ createsACard, webhookName, ruleName, ruleMatcher, updateCard }) => {
    logger.trace(`Attaching listener for ${webhookName}`)
    robot.on(webhookName, async function (context) {
      logger.trace(`Event received for ${webhookName}`)
      let issueUrl = ''
      let projectCardNodeId = ''

      if (context.payload.issue) {
        // if payload is an issue
        issueUrl = context.payload.issue.html_url
      } else if (context.payload.project_card) {
        // if payload is a project card
        projectCardNodeId = context.payload.project_card.node_id
      } else {
        // if payload is a pull request
        const graphResult = await retryQuery(context, `
          query getIssueFromPullRequest($pullRequestUrl: URI!) {
            resource(url: $pullRequestUrl) {
              ... on PullRequest {
                body
              }
            }
          }
        `, { pullRequestUrl: context.payload.pull_request.html_url })

        if (graphResult && graphResult.resource) {
          issueUrl = getIssueFromBody(graphResult.resource.body)
        }

        issueUrl = issueUrl || context.payload.pull_request.html_url.replace('/pull/', '/issues/')
      }

      // A couple commands occur when a new Issue or Pull Request is created.
      // In those cases, a new Card needs to be created, rather than moving an existing card.

      // If Project Card Node ID is provided then enter into closing issue
      if (projectCardNodeId) {
        const graphResult = await retryQuery(context, `
        query getColumnCards($projectCardNodeId: ID!) {
          node(id: $projectCardNodeId) {
            ... on ProjectCard {
              content {
                ... on Issue {
                  id
                  closed
                  number
                }
              }
              column {
                id
                url
                firstCards: cards(first: 1, archivedStates: NOT_ARCHIVED) {
                  totalCount
                  nodes {
                    url
                    id
                    note
                  }
                }
                lastCards: cards(last: 2, archivedStates: NOT_ARCHIVED) {
                  totalCount
                  nodes {
                    url
                    id
                    note
                  }
                }
              }
            }
          }
        }
        `, { projectCardNodeId: projectCardNodeId })
        logger.debug(graphResult, 'Retrieved results')

        const projects = [{ columns: { nodes: [graphResult.node.column] } }]
        const automationRules = extractAutomationRules(projects).filter(({ ruleName: rn }) => rn === ruleName)

        for (const { column, ruleArgs, lastCardId, cardId } of automationRules) {
          if (await ruleMatcher(logger, context, ruleArgs)) {
            if (updateCard) {
              await updateCard(logger, context, graphResult.node.content)
            }
            logger.info(`Moving Rule Card ${cardId} to bottom of column ${column.id}`)
            await updateRuleCard(context, lastCardId, cardId, column.id)
          }
        }
      } else if (createsACard) {
        const graphResult = await retryQuery(context, `
          query getAllProjectCards($issueUrl: URI!) {
            resource(url: $issueUrl) {
              ... on Issue {
                id
                repository {
                  owner {
                    url
                    ${''/* Projects can be attached to an Organization... */}
                    ... on Organization {
                      projects(first: 10, states: [OPEN]) {
                        nodes {
                          ${PROJECT_FRAGMENT}
                        }
                      }
                    }
                  }
                  ${''/* ... or on a Repository */}
                  projects(first: 10, states: [OPEN]) {
                    nodes {
                      ${PROJECT_FRAGMENT}
                    }
                  }
                }
              }
            }
          }
        `, { issueUrl: issueUrl })
        const { resource } = graphResult

        let allProjects = []
        if (resource.repository.owner.projects) {
          // Add Org Projects
          allProjects = allProjects.concat(resource.repository.owner.projects.nodes)
        }
        if (resource.repository.projects) {
          allProjects = allProjects.concat(resource.repository.projects.nodes)
        }

        // Loop through all of the Automation Cards and see if any match
        const automationRules = extractAutomationRules(allProjects).filter(({ ruleName: rn }) => rn === ruleName)

        for (const { column, ruleArgs, lastCardId, cardId } of automationRules) {
          if (await ruleMatcher(logger, context, ruleArgs)) {
            logger.info(`Creating Card for "${issueUrl}" to column ${column.id} because of "${ruleName}" and value: "${ruleArgs}"`)
            await context.github.graphql(`
              mutation createCard($contentId: ID!, $columnId: ID!) {
                addProjectCard(input: {contentId: $contentId, projectColumnId: $columnId}) {
                  clientMutationId
                }
              }
            `, { contentId: resource.id, columnId: column.id })

            logger.info(`Moving Rule Card ${cardId} to bottom of column ${column.id}`)
            await updateRuleCard(context, lastCardId, cardId, column.id)
          }
        }
      } else {
        // Check if we need to move the Issue (or Pull request)
        const graphResult = await retryQuery(context, `
         query getCardAndColumnAutomationCards($issueUrl: URI!) {
           resource(url: $issueUrl) {
             ... on Issue {
               projectCards(first: 10) {
                 nodes {
                   id
                   url
                   column {
                     name
                     id
                   }
                   project {
                     ${PROJECT_FRAGMENT}
                   }
                 }
               }
             }
           }
         }
       `, { issueUrl: issueUrl })
        logger.debug(graphResult, 'Retrieved results')
        const { resource } = graphResult
        // sometimes there are no projectCards
        if (!resource.projectCards) {
          logger.error(issueUrl, resource, 'Not even an array for project cards. Odd')
        }
        const cardsForIssue = resource.projectCards ? resource.projectCards.nodes : []

        for (const issueCard of cardsForIssue) {
          const automationRules = extractAutomationRules([issueCard.project]).filter(({ ruleName: rn }) => rn === ruleName)

          for (const { column, ruleArgs, lastCardId, cardId } of automationRules) {
            if (await ruleMatcher(logger, context, ruleArgs)) {
              if (updateCard) {
                const { columnId, lastCardInCloseColumnId, closeCardId } = await updateCard(logger, context, resource, { ruleArgs })
                logger.info(`Moving Rule Card ${closeCardId} to bottom of column ${columnId}`)
                await updateRuleCard(context, lastCardInCloseColumnId, closeCardId, columnId)
              } else {
                logger.info(`Moving Card ${issueCard.id} for "${issueUrl}" to column ${column.id} because of "${ruleName}" and value: "${ruleArgs}"`)
                await context.github.graphql(`
                 mutation moveCard($cardId: ID!, $columnId: ID!) {
                   moveProjectCard(input: {cardId: $cardId, columnId: $columnId}) {
                     clientMutationId
                   }
                 }
               `, { cardId: issueCard.id, columnId: column.id })

                logger.info(`Moving Rule Card ${cardId} to bottom of column ${column.id}`)
                await updateRuleCard(context, lastCardId, cardId, column.id)
              }
            }
          }
        }
      }
    })
  })
}
