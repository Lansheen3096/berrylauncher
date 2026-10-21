from PIL import Image, ImageDraw

P = {
 ' ': None,
 'g': (61, 220, 132, 255),
 'G': (34, 160, 92, 255),
 'r': (232, 67, 94, 255),
 'R': (255, 92, 119, 255),
 'w': (255, 209, 217, 255),
 'd': (168, 36, 62, 255),
}
art = [
"................",
"................",
".....g...g......",
"....ggg.gGg.....",
"...ggggggggg....",
"....gGGGGGg.....",
"....rRRRRRr.....",
"...rRwRRRRRr....",
"..rRRwRRrRRRr...",
"..rRRRRRrRRRr...",
"..rRRrrRrRRRr...",
"...rRRrRRRRr....",
"...rRRRRRRRr....",
"....rRRRRRr.....",
".....rRdRr......",
"......rrr.......",
]
size = 16
berry = Image.new('RGBA', (size, size), (0,0,0,0))
for y,row in enumerate(art):
    for x,ch in enumerate(row):
        c = P.get(ch)
        if c: berry.putpixel((x,y),c)

plate = Image.new('RGBA', (size,size), (0,0,0,0))
d = ImageDraw.Draw(plate)
d.rounded_rectangle([0,0,size-1,size-1], radius=3, fill=(9,24,18,255))
d.rounded_rectangle([0,0,size-1,size-1], radius=3, outline=(61,220,132,90))
plate.alpha_composite(berry)

out = plate.resize((512,512), Image.NEAREST)
out.save('build/icon.png')
plate.resize((256,256), Image.NEAREST).save('build/icon.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('ok')
