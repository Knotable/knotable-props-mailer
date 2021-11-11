Meteor.startup ->
  console.log "============================================"
  init_github_settings()
  init_aws()
  initSlingshot()
  console.log "============================================"

process.on 'uncaughtException', (err) ->
  console.trace err