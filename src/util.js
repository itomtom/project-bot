// Extract issue url from PR body
module.exports = function getIssueFromBody (body) {
  let url = ''
  const regex = /(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) ([A-Za-z0-9/\-:.]+)/i
  const result = body.match(regex)
  if (result && result[2]) {
    url = result[2]
  }
  return url
}
