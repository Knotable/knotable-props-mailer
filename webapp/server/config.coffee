@init_github_settings = ->
  console.log "Init Github"
  unless Meteor.settings.github.client_id and Meteor.settings.github.client_secret
    throw new Meteor.Error 'Github settings not found. Tearing down the server'
  ServiceConfiguration.configurations.remove service: "github"
  ServiceConfiguration.configurations.insert
    service: "github"
    clientId: Meteor.settings.github.client_id
    secret: Meteor.settings.github.client_secret



@init_aws = ->
  console.info 'Init AWS'
  Meteor.settings.AWS = {} unless Meteor.settings.AWS

  # override AWS settings if these settings are exist in global variables
  # AWS_BUCKET
  # AWS_USERNAME
  # AWS_ACCESS_KEY_ID
  # AWS_SECRET_ACCESS_KEY
  if process.env.AWS_BUCKET
    console.info "Write AWS settings from global variables"
    Meteor.settings.AWS =
      bucket: process.env.AWS_BUCKET
      username: process.env.AWS_USERNAME
      accessKeyId: process.env.AWS_ACCESS_KEY_ID
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY

  if Meteor.settings.AWS
    Meteor.settings.public.aws = {bucket: Meteor.settings.AWS.bucket}
    AWS.config.update
      port: 443
      accessKeyId: Meteor.settings.AWS.accessKeyId
      secretAccessKey: Meteor.settings.AWS.secretAccessKey
  else
    console.warn "AWS settings missing"



@initSlingshot = ->
  Slingshot.fileRestrictions 'contentImageUploads',
    allowedFileTypes: null
    maxSize: 50 * 1024 * 1024


  Slingshot.createDirective 'contentImageUploads', Slingshot.S3Storage,
    bucket: Meteor.settings.AWS.bucket
    AWSAccessKeyId: Meteor.settings.AWS.accessKeyId
    AWSSecretAccessKey: Meteor.settings.AWS.secretAccessKey
    acl: 'public-read'
    authorize: ->
      return true if @userId
      throw new Meteor.Error 'Login Required', 'Please login before posting files'
    key: (file, metaContext) ->
      FileHelper.contentImageKey file.name