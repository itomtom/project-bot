const commonmark = require('commonmark')
const commonmarkParser = new commonmark.Parser()

// Parse Markdown of the form:
//
// ```md
// ###### Automation Rules
//
// - `assigned_issue`
// - `closed_issue`
// - `added_label` **wontfix**
// - `new_pullrequest` **foo-bar** **test**
// ```
function parseMarkdown (card) {
  if (!card.note) {
    return [] // no Rules
  }
  const root = commonmarkParser.parse(card.note)
  const walker = root.walker()
  const parsedRules = []
  let walkEvent
  while ((walkEvent = walker.next())) {
    const { node } = walkEvent
    // Each item should be simple text that contains the rule, followed by a space,
    // followed by any arguments (sometimes wrapped in spaces)
    if (walkEvent.entering && node.type === 'code') {
      if (node.parent.type === 'paragraph' && node.parent.parent.type === 'item') {
        let args = []
        let argsNode = node
        while ((argsNode = argsNode.next)) {
          if (argsNode.type === 'strong' || argsNode.type === 'emph') {
            if (argsNode.firstChild.type === 'text') {
              args.push(argsNode.firstChild.literal.trim())
            }
          }
        }
        // Try splitting up the text (backwards-compatibility)
        if (args.length === 0 && node.next && node.next.literal) {
          args = node.next.literal.trim().split(' ').map((arg) => arg.trim())
        }
        parsedRules.push({ ruleName: node.literal, ruleArgs: args })
      }
    }
  }
  return parsedRules
}

// For parse out all the Automation Rules from Cards in a Project
module.exports = function extractAutomationRules (projects) {
  const automationRules = []

  // Use a Map to deduplicate because .firstCards and .lastCards could be the same Card
  const allCards = new Map()
  projects.forEach((project) => {
    project.columns.nodes.forEach((column) => {
      let lastCardId = null
      if (column.lastCards.nodes.length > 1) {
        lastCardId = column.lastCards.nodes[column.lastCards.nodes.length - 1].id
      }

      column.firstCards.nodes.forEach((card) => {
        allCards.set(card.id, { card, column, lastCardId })
      })
      column.lastCards.nodes.forEach((card) => {
        allCards.set(card.id, { card, column, lastCardId })
      })
    })
  })

  allCards.forEach(({ card, column, lastCardId }) => {
    const rules = parseMarkdown(card)
    rules.forEach((r) => {
      const rule = {
        column,
        ruleName: r.ruleName,
        ruleArgs: r.ruleArgs,
        cardId: card.id
      }

      if (card.id !== lastCardId) {
        rule.lastCardId = lastCardId
      }
      automationRules.push(rule)
    })
  })
  return automationRules
}
