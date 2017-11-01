accountHelper =
  validateGithubAccess: (userGithubService) ->
    { username, accessToken } = userGithubService
    { organization_name, repo_access, team } = Meteor.settings.github
    githubApi = new GithubApi accessToken, "User-Agent": "Meteor/1.0"
    try
    # For non developers we expect to see them in configured team
      console.log "[#{username}] Try to access via team membership", team
      requiredMembership = githubApi.getTeamMembership team.id, username
      if requiredMembership.state isnt 'active'
        throw new Meteor.Error 'Access denied: membership state is not active'
    catch err
      console.error "[#{username}] No access via team membership", team, err.message or err
      console.log "[#{username}] Try to access as developer", { repo_access }
      repos = githubApi.getOrganizationRepos organization_name
      names = _.pluck repos, "name"
      # Let developers have access to the app if they have access to configured repo
      unless _.contains names, repo_access
        console.error "[#{username}] No developers access allowed", { repo_access }
        throw new Meteor.Error 403, "To login you should have access to github team or repository"
    true



Accounts.onCreateUser (options, user) ->
  { accessToken } = user.services.github
  githubApi = new GithubApi accessToken, "User-Agent": "Meteor/1.0"
  user.profile = _.pick githubApi.user(),
    "login", "name", "avatar_url", "url", "company", "blog", "location", "email", "bio", "html_url"
  user



Accounts.validateNewUser (user) ->
  accountHelper.validateGithubAccess user.services.github



Accounts.validateLoginAttempt (attempt) ->
  return false unless attempt.allowed
  return true if attempt.type is 'resume'
  # Define some time frame to skip login validation for new
  # users as far as we perform this check on account creation
  return true if moment().subtract(1, 'minute').isBefore(attempt.user.createdAt)
  accountHelper.validateGithubAccess attempt.user.services.github



Accounts.registerLoginHandler (loginRequest) ->
  console.log "loginRequest:", loginRequest
  unless loginRequest.token
    return undefined
  user = Meteor.users.findOne({'services.invitation.loginToken': loginRequest.token})
  if user
    userId = user._id
    stampedToken = Accounts._generateStampedLoginToken()
    hashStampedToken = Accounts._hashStampedToken(stampedToken)
    console.log "#loginHandler token ##{hashStampedToken}"
    Meteor.users.update userId, {
      $push: {'services.resume.loginTokens': hashStampedToken}
    }

    result = {
      userId: userId,
      token: stampedToken.token
    }
    return result
  return undefined
