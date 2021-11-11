init_mailservice = ->
  # Mailgun SMTP settings
  process.env.MAIL_URL = mail_url Meteor.settings.mailgun.username,
    Meteor.settings.mailgun.password,
    Meteor.settings.mailgun.host,
    Meteor.settings.mailgun.port
  console.log "******---------- MAIL URL -----------******", process.env.MAIL_URL



# http://docs.meteor.com/#email
# the MAIL_URL environment variable should be of the form smtp://USERNAME:PASSWORD@HOST:PORT/.
# for example: 'smtp://postmaster%40iyou.mailgun.org:7q9uwgjfx394@smtp.mailgun.org:587'
mail_url = (username, password, host, port) ->
  return 'smtp://' + username.replace(/@/, '%40') + ':' + password + '@' + host + ':' + port


retrieveDefaultMailingLists = ->
  try
    mailingListServer.syncMailingListFromMailGun()
  catch e
    console.log e if e



Meteor.startup ->
  init_mailservice()
  retrieveDefaultMailingLists()
  console.log "Started email service"