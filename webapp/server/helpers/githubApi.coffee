class @GithubApi
  constructor: (@accessToken, headers) ->
    check @accessToken, String
    check headers, Match.Optional Object
    @baseUrl = 'https://api.github.com'
    @_headers = Object.assign({
      "Authorization": "token #{@accessToken}"
    }, headers)



  call: (request) ->
    { method, url, headers } = request
    headers ?= {}
    _.extend headers, @_headers
    result = HTTP.call method, "#{@baseUrl}#{url}", { headers }
    result.data



  user: ->
    @call
      method: 'GET'
      url: '/user'



  getTeamMembership: (teamId, username) ->
    check teamId, Match.OneOf String, Number
    check username, String
    @call
      method: 'GET'
      url: "/teams/#{teamId}/memberships/#{username}"



  getOrganizationRepos: (organization, params = new URLSearchParams()) ->
    check organization, String
    @call
      method: 'GET'
      url: "/orgs/#{organization}/repos?#{params}"