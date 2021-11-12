retrieveDefaultMailingLists = ->
  try
    mailingListServer.syncMailingListFromMailGun()
  catch e
    console.log e



Meteor.startup ->
  retrieveDefaultMailingLists()
  console.log "Started email service"