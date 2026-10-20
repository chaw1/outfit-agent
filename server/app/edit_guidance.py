"""Describe a local edit's canvas and visible target without another model call."""

from app.local_edit import EditSelection


def local_edit_prompt(
    instruction: str, selection: EditSelection, *, full_reference: bool = False
) -> str:
    left, top, _, _ = selection.crop_box
    x0, y0, x1, y1 = selection.mask.getbbox()
    offset_x, offset_y, _, _ = selection.canvas_box
    width, height = selection.canvas_size
    target = (
        f"({(x0 - left + offset_x) / width:.3f},"
        f"{(y0 - top + offset_y) / height:.3f})至"
        f"({(x1 - left + offset_x) / width:.3f},"
        f"{(y1 - top + offset_y) / height:.3f})"
    )
    reference_roles = (
        "最后一张参考图是唯一待编辑的局部裁剪画布；倒数第二张是其完整原图，"
        "只用于理解人物、衣服结构和裁剪位置；更前面的图片仅供原衣服细节参考。"
        if full_reference else
        "最后一张参考图是唯一待编辑的局部裁剪画布；前面的图片仅供原衣服细节参考。"
    )
    return (
        reference_roles +
        "严格保持最后一张图的画幅、镜头、人物位置和局部构图，输出同一裁剪块。"
        "不要输出全身照，不要扩展到裁剪块之外，不要把原衣服产品图当成编辑画布。"
        f"画布内的修改范围约为归一化坐标{target}，范围外作为对齐上下文保留。"
        "先理解用户要看到的最终状态，再落实用户要求的可见变化，不能原样复制。"
        "若要求结构或物体状态变化，不能只调色；若要求颜色或亮度，仅改变对应属性。"
        "未被本次指令要求改变的服装品类、袖长设计、面料、纽扣和口袋保持原样。"
        "用户要求的新状态优先于参考图里的旧状态，参考图只约束未要求改变的属性。"
        "理解目标状态的例子（只执行用户本次要求）：袖口放下来是展开卷起的一折，"
        "卷边消失，下缘比原来降低约一折宽度，保持原短袖或长袖版型，不能把短袖改成长袖；"
        "衬衫塞进裤腰是下摆全部进入裤腰内，露出连续裤腰线，腰下不留悬垂衣摆；"
        "去掉吊牌是删除指定纸牌及其细绳，用邻近同色布纹和光照补齐，不能变成徽章或布贴。"
        "不要扩大用户指定范围。用户原始指令：" + instruction
    )
