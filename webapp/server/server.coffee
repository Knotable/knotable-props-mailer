Meteor.startup ->
  console.log "============================================"
  console.log 'Domain:', process.env.DOMAIN_LONG
  init_github_settings()
  init_aws()
  initSlingshot()
  console.log "============================================"

process.on 'uncaughtException', (err) ->
  console.trace err